//! Outgoing HTTP for the components this crate runs.
//!
//! `wasmtime-wasi-http` hands every request a guest sends to
//! [`WasiHttpHooks::send_request`]. Its default implementation opens a
//! TCP connection and a TLS session per request and speaks HTTP/1.1
//! only. [`HttpHooks`] replaces it with one pooled client per process:
//! `https://` connections advertise `h2` and `http/1.1` through ALPN and
//! use HTTP/2 when the server picks it, `http://` connections use
//! HTTP/1.1, and an idle connection is reused by the next request to the
//! same scheme and authority. gRPC needs HTTP/2 and response trailers;
//! both reach the guest unchanged.
//!
//! A `wasi:http` guest cannot ask for a protocol version, and gRPC is
//! never valid over HTTP/1.1, so an `http://` request whose content type
//! is `application/grpc` (or `application/grpc+<codec>`) goes over
//! cleartext HTTP/2 with prior knowledge (h2c), on a pool of its own.
//! That is how a gRPC client reaches a local server or emulator.
//!
//! Connections live on a background runtime of their own (one worker
//! thread named `zena-http`). A component runs on a current-thread
//! runtime that [`crate::component::run_main`] builds per call, and
//! `zena:wasm` starts each child on a thread and runtime of its own. A
//! connection whose I/O was registered with one of those runtimes would
//! stop working when it ends, and would make no progress while the
//! guest blocks the thread, so every connect and every connection task
//! runs on the background runtime. Bodies cross between the runtimes
//! through hyper's and wasmtime's channels.
//!
//! The request options keep the meaning they have in the default
//! implementation: the connect timeout bounds the TCP connect and the
//! TLS handshake, the first-byte timeout bounds the wait for response
//! headers once a connection has taken the request, and the
//! between-bytes timeout bounds the gap between response body frames.
//!
//! Where a request may connect is the process's [`EgressPolicy`], which the
//! embedder sets in the environment: anywhere by default, and with
//! `ZENA_DENY_PRIVATE_EGRESS=1` only to addresses on the public internet,
//! but for the host names `ZENA_ALLOW_EGRESS` lists. A server that reads
//! URLs other people chose (a DID document's PDS, an avatar) sets it, so
//! that a public name pointed at a private address cannot reach what is
//! behind the server.

use bytes::Bytes;
use http::uri::Scheme;
use http::{Request, Response, Uri};
use http_body::{Body, Frame, SizeHint};
use http_body_util::BodyExt as _;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};

/// The timeout the default implementation uses for each option a
/// request leaves unset.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

tokio::task_local! {
    /// The connect timeout of the request being sent. The pooled client
    /// passes its connector only the destination, so the connector reads
    /// the timeout from here; `Connector::call` runs inside the request's
    /// own task, where this is set.
    static CONNECT_TIMEOUT: Duration;
}

/// The `wasi:http` hooks of every component this crate runs: the default
/// behaviour, except that requests go through an [`HttpClient`].
pub struct HttpHooks {
    client: HttpClient,
}

impl HttpHooks {
    pub fn new(client: HttpClient) -> HttpHooks {
        HttpHooks { client }
    }
}

impl Default for HttpHooks {
    /// Hooks on the process-wide client, [`HttpClient::shared`].
    fn default() -> HttpHooks {
        HttpHooks::new(HttpClient::shared().clone())
    }
}

impl WasiHttpHooks for HttpHooks {
    /// The client adds `host` itself on HTTP/1.1 connections, from the
    /// URI. On HTTP/2 the authority travels as `:authority`, and RFC 9113
    /// asks clients not to send `host` there as well.
    fn set_host_header(&mut self) -> bool {
        false
    }

    fn send_request(
        &mut self,
        request: Request<WasiBody>,
        options: Option<RequestOptions>,
        fut: Box<dyn Future<Output = Result<(), Error>> + Send>,
    ) -> Box<
        dyn Future<
                Output = Result<
                    (
                        Response<WasiBody>,
                        Box<dyn Future<Output = Result<(), Error>> + Send>,
                    ),
                    Error,
                >,
            > + Send,
    > {
        // The default implementation ignores the response-processing
        // result too.
        _ = fut;
        let send = self.client.send(request, options);
        Box::new(async move {
            let response = send.await?;
            // Connection I/O runs on the background runtime, and an error
            // there reaches the guest through the response body, so there
            // is no I/O future for the caller to drive.
            let io: Box<dyn Future<Output = Result<(), Error>> + Send> = Box::new(async { Ok(()) });
            Ok((response, io))
        })
    }
}

/// Where outgoing requests may connect. By default anywhere. With
/// `deny_private`, only to public addresses ([`is_public`]): a name is
/// resolved once, refused with `DestinationIpProhibited` when any of its
/// addresses is not public, and connected to at exactly the addresses
/// checked, so a second lookup cannot answer differently (DNS rebinding).
/// The hosts in `allowed` are exempt: on Cloud Run, for one, the metadata
/// server that gives the service its credentials is link-local.
#[derive(Clone, Debug, Default)]
pub struct EgressPolicy {
    pub deny_private: bool,
    /// Host names, or IP addresses as written in a URL, compared without
    /// regard to case.
    pub allowed: Vec<String>,
}

impl EgressPolicy {
    /// The policy the environment sets: `ZENA_DENY_PRIVATE_EGRESS=1`
    /// denies private addresses, and `ZENA_ALLOW_EGRESS` lists the exempt
    /// hosts, separated by commas.
    pub fn from_env() -> EgressPolicy {
        EgressPolicy::from_vars(
            std::env::var("ZENA_DENY_PRIVATE_EGRESS").ok(),
            std::env::var("ZENA_ALLOW_EGRESS").ok(),
        )
    }

    fn from_vars(deny: Option<String>, allow: Option<String>) -> EgressPolicy {
        EgressPolicy {
            deny_private: deny.as_deref().map(str::trim) == Some("1"),
            allowed: allow
                .unwrap_or_default()
                .split(',')
                .map(|host| host.trim().to_ascii_lowercase())
                .filter(|host| !host.is_empty())
                .collect(),
        }
    }

    /// Whether requests to `host` may connect anywhere.
    fn exempts(&self, host: &str) -> bool {
        self.allowed
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
    }
}

/// Whether `ip` is an address on the public internet: not unspecified,
/// loopback, private, link-local, shared (carrier-grade NAT), reserved for
/// documentation, benchmarking or the IETF, multicast or broadcast, nor
/// an IPv6 address that is unique-local, site-local or embeds an IPv4
/// address that is none of those.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            let embedded = |high: u16, low: u16| {
                Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
            };
            // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) reach the IPv4
            // address they embed.
            if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                return is_public_v4(embedded(s[6], s[7]));
            }
            if s[0] == 0x2002 {
                return is_public_v4(embedded(s[1], s[2]));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                // IPv4-compatible (::a.b.c.d), deprecated.
                || s[0..6] == [0, 0, 0, 0, 0, 0]
                // Unique local (fc00::/7), link-local (fe80::/10) and
                // site-local (fec0::/10).
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0
                // Documentation (2001:db8::/32) and discard (100::/64).
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || s[0..4] == [0x0100, 0, 0, 0])
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(o[0] == 0
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        // Shared address space (100.64.0.0/10), for carrier-grade NAT.
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        // IETF protocol assignments (192.0.0.0/24) and benchmarking
        // (198.18.0.0/15).
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        || ip.is_documentation()
        // Multicast, reserved and broadcast (224.0.0.0 and up).
        || o[0] >= 224)
}

/// A pooled HTTP client. Clones share its pools.
#[derive(Clone)]
pub struct HttpClient {
    client: Client<Connector, RequestBody>,
    /// HTTP/2 only, for `http://` gRPC requests (h2c with prior
    /// knowledge); see the module documentation.
    h2c: Client<Connector, RequestBody>,
}

impl HttpClient {
    /// The process-wide client, which trusts the Mozilla roots bundled in
    /// `webpki-roots` (the roots the default implementation trusts), and
    /// connects where the environment's [`EgressPolicy`] allows.
    pub fn shared() -> &'static HttpClient {
        static SHARED: OnceLock<HttpClient> = OnceLock::new();
        SHARED.get_or_init(|| {
            HttpClient::with_egress(
                rustls::RootCertStore {
                    roots: webpki_roots::TLS_SERVER_ROOTS.into(),
                },
                EgressPolicy::from_env(),
            )
        })
    }

    /// A client with its own pool that trusts `roots` for `https://`, and
    /// connects anywhere.
    pub fn with_roots(roots: rustls::RootCertStore) -> HttpClient {
        HttpClient::with_egress(roots, EgressPolicy::default())
    }

    /// A client with its own pool that trusts `roots` for `https://`, and
    /// connects where `egress` allows.
    pub fn with_egress(roots: rustls::RootCertStore, egress: EgressPolicy) -> HttpClient {
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let connector = Connector {
            tls: tokio_rustls::TlsConnector::from(Arc::new(tls)),
            egress: Arc::new(egress),
        };
        let client = Client::builder(TokioExecutor::new())
            .timer(TokioTimer::new())
            .pool_timer(TokioTimer::new())
            .build(connector.clone());
        let h2c = Client::builder(TokioExecutor::new())
            .timer(TokioTimer::new())
            .pool_timer(TokioTimer::new())
            .http2_only(true)
            .build(connector);
        HttpClient { client, h2c }
    }

    /// Sends `request`, resolving to the response once its headers have
    /// arrived. The request must carry a scheme and an authority, as
    /// `wasmtime-wasi-http` builds it.
    pub fn send(
        &self,
        request: Request<WasiBody>,
        options: Option<RequestOptions>,
    ) -> impl Future<Output = Result<Response<WasiBody>, Error>> + Send + 'static {
        let options = options.unwrap_or_default();
        let connect_timeout = options.connect_timeout.unwrap_or(DEFAULT_TIMEOUT);
        let first_byte_timeout = options.first_byte_timeout.unwrap_or(DEFAULT_TIMEOUT);
        let between_bytes_timeout = options.between_bytes_timeout.unwrap_or(DEFAULT_TIMEOUT);
        let client = if is_cleartext_grpc(&request) {
            self.h2c.clone()
        } else {
            self.client.clone()
        };
        async move {
            if request.uri().authority().is_none() {
                return Err(Error::HttpRequestUriInvalid);
            }
            let dispatched = Arc::new(Notify::new());
            let request = request.map(|body| RequestBody {
                inner: body,
                dispatched: Some(dispatched.clone()),
            });
            let task = background().spawn(CONNECT_TIMEOUT.scope(
                connect_timeout,
                receive_head(client, request, dispatched, first_byte_timeout),
            ));
            let response = AbortOnDrop(task).await.map_err(|e| {
                Error::InternalError(Some(format!("HTTP client task failed: {e}")))
            })??;
            let mut timeout = tokio::time::interval(between_bytes_timeout);
            timeout.reset();
            Ok(response.map(|incoming| ResponseBody { incoming, timeout }.boxed_unsync()))
        }
    }
}

/// Whether `request` is gRPC to an `http://` origin, which goes over
/// h2c; see the module documentation.
fn is_cleartext_grpc<B>(request: &Request<B>) -> bool {
    if request.uri().scheme() != Some(&Scheme::HTTP) {
        return false;
    }
    let Some(content_type) = request.headers().get(http::header::CONTENT_TYPE) else {
        return false;
    };
    let Ok(content_type) = content_type.to_str() else {
        return false;
    };
    let content_type = content_type.to_ascii_lowercase();
    content_type == "application/grpc"
        || content_type.starts_with("application/grpc+")
        || content_type.starts_with("application/grpc;")
}

/// The runtime every connection lives on; see the module documentation.
fn background() -> &'static tokio::runtime::Handle {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("zena-http")
                .enable_all()
                .build()
                .expect("failed to start the HTTP client runtime")
        })
        .handle()
}

/// Sends `request` and waits for the response headers. The first-byte
/// timeout starts when a connection takes the request, which
/// `dispatched` reports, so time spent connecting does not count
/// against it (the connector bounds that with the connect timeout).
async fn receive_head(
    client: Client<Connector, RequestBody>,
    request: Request<RequestBody>,
    dispatched: Arc<Notify>,
    first_byte_timeout: Duration,
) -> Result<Response<hyper::body::Incoming>, Error> {
    let mut response = std::pin::pin!(client.request(request));
    tokio::select! {
        biased;
        res = &mut response => return res.map_err(client_error),
        () = dispatched.notified() => {}
    }
    match tokio::time::timeout(first_byte_timeout, response).await {
        Ok(res) => res.map_err(client_error),
        Err(_) => Err(Error::ConnectionReadTimeout),
    }
}

/// Maps a pooled-client error to the `wasi:http` error the default
/// implementation would report for the same failure.
fn client_error(err: hyper_util::client::legacy::Error) -> Error {
    let mut source = err.source();
    while let Some(cause) = source {
        // A connect failure, or a request body error hyper passed on.
        if let Some(carried) = cause.downcast_ref::<Carried>() {
            if let Some(error) = carried.take() {
                return error;
            }
        }
        source = cause.source();
    }
    // A hyper error with no `wasi:http` error under it. The default
    // implementation reports it as `Error::Hyper`, which the default
    // `p3_error_from_hyper` hook maps to `HttpProtocolError`; the
    // pooled client keeps the `hyper::Error` itself, so map it here.
    let mut source = err.source();
    while let Some(cause) = source {
        if cause.is::<hyper::Error>() {
            return Error::HttpProtocolError;
        }
        source = cause.source();
    }
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message = format!("{message}: {cause}");
        source = cause.source();
    }
    Error::InternalError(Some(message))
}

/// A `wasi:http` error passed through hyper as the source of one of its
/// own errors. hyper keeps the error behind a shared reference, so it is
/// moved out with [`Carried::take`] when the request fails.
struct Carried(Mutex<Option<Error>>);

impl Carried {
    fn new(error: Error) -> Carried {
        Carried(Mutex::new(Some(error)))
    }

    fn take(&self) -> Option<Error> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

impl fmt::Debug for Carried {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(error) => fmt::Debug::fmt(error, f),
            None => f.write_str("(error already reported)"),
        }
    }
}

impl fmt::Display for Carried {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(error) => fmt::Display::fmt(error, f),
            None => f.write_str("(error already reported)"),
        }
    }
}

impl StdError for Carried {}

/// Aborts a spawned task when the future waiting on it is dropped, so a
/// guest that abandons a request does not leave it running.
struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Future for AbortOnDrop<T> {
    type Output = Result<T, tokio::task::JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx)
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A request body that reports, through `dispatched`, the first time
/// hyper looks at it. hyper does that once a connection has taken the
/// request (it asks `is_end_stream` before writing the head on both
/// HTTP/1.1 and HTTP/2), which is when the first-byte timeout starts.
struct RequestBody {
    inner: WasiBody,
    dispatched: Option<Arc<Notify>>,
}

impl RequestBody {
    fn notify(&self) {
        if let Some(dispatched) = &self.dispatched {
            dispatched.notify_one();
        }
    }
}

impl Body for RequestBody {
    type Data = Bytes;
    type Error = Carried;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Carried>>> {
        if let Some(dispatched) = self.dispatched.take() {
            dispatched.notify_one();
        }
        Pin::new(&mut self.inner)
            .poll_frame(cx)
            .map(|frame| frame.map(|frame| frame.map_err(Carried::new)))
    }

    fn is_end_stream(&self) -> bool {
        self.notify();
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.notify();
        self.inner.size_hint()
    }
}

/// A response body with the between-bytes timeout applied, as in the
/// default implementation.
struct ResponseBody {
    incoming: hyper::body::Incoming,
    timeout: tokio::time::Interval,
}

impl Body for ResponseBody {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Error>>> {
        match Pin::new(&mut self.incoming).poll_frame(cx) {
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Ready(Some(Err(err))) => {
                let err = if err.is_timeout() {
                    Error::HttpResponseTimeout
                } else {
                    Error::from(err)
                };
                Poll::Ready(Some(Err(err)))
            }
            Poll::Ready(Some(Ok(frame))) => {
                self.timeout.reset();
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Pending => {
                ready!(self.timeout.poll_tick(cx));
                Poll::Ready(Some(Err(Error::ConnectionReadTimeout)))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.incoming.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.incoming.size_hint()
    }
}

/// Opens connections for the pooled client: TCP, then TLS with ALPN for
/// `https://`.
#[derive(Clone)]
struct Connector {
    tls: tokio_rustls::TlsConnector,
    egress: Arc<EgressPolicy>,
}

impl tower_service::Service<Uri> for Connector {
    type Response = TokioIo<Stream>;
    type Error = Carried;
    type Future = Pin<Box<dyn Future<Output = Result<TokioIo<Stream>, Carried>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Carried>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, dst: Uri) -> Self::Future {
        let timeout = CONNECT_TIMEOUT
            .try_with(|timeout| *timeout)
            .unwrap_or(DEFAULT_TIMEOUT);
        let tls = self.tls.clone();
        let egress = self.egress.clone();
        Box::pin(async move {
            connect(tls, &egress, dst, timeout)
                .await
                .map(TokioIo::new)
                .map_err(Carried::new)
        })
    }
}

/// Connects to `dst`, where `egress` allows, with the errors the default
/// implementation reports.
async fn connect(
    tls: tokio_rustls::TlsConnector,
    egress: &EgressPolicy,
    dst: Uri,
    timeout: Duration,
) -> Result<Stream, Error> {
    let authority = dst.authority().ok_or(Error::HttpRequestUriInvalid)?;
    let use_tls = dst.scheme() == Some(&Scheme::HTTPS);
    let authority = if authority.port().is_some() {
        authority.to_string()
    } else {
        let port = if use_tls { 443 } else { 80 };
        format!("{authority}:{port}")
    };
    // An IPv6 host is bracketed in the URI, and listed without brackets.
    let host = dst
        .host()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let checked = egress.deny_private && !egress.exempts(host);
    let tcp = match tokio::time::timeout(timeout, open(&authority, checked)).await {
        Ok(stream) => stream?,
        Err(_) => return Err(Error::ConnectionTimeout),
    };
    // Small writes (gRPC messages, HTTP/2 control frames) should not wait
    // for Nagle's algorithm.
    let _ = tcp.set_nodelay(true);
    if !use_tls {
        return Ok(Stream::Plain(tcp));
    }
    let name = tls_server_name(&authority)?;
    match tokio::time::timeout(timeout, tls.connect(name, tcp)).await {
        Ok(stream) => Ok(Stream::Tls(Box::new(stream.map_err(Error::Tls)?))),
        Err(_) => Err(Error::ConnectionTimeout),
    }
}

/// A TCP connection to `authority`, `host:port`. When `checked`, the name
/// is resolved here, refused unless every address it has is public, and
/// connected to at those addresses, so nothing resolves it again.
async fn open(authority: &str, checked: bool) -> Result<TcpStream, Error> {
    if !checked {
        return TcpStream::connect(authority).await.map_err(Error::Connect);
    }
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host(authority)
        .await
        .map_err(Error::Connect)?
        .collect();
    if addresses.is_empty() {
        return Err(Error::DestinationNotFound);
    }
    if addresses.iter().any(|address| !is_public(address.ip())) {
        return Err(Error::DestinationIpProhibited);
    }
    TcpStream::connect(&addresses[..])
        .await
        .map_err(Error::Connect)
}

/// The rustls server name for an outbound `host:port` authority, where
/// an IPv6 host is bracketed. Copied from `wasmtime-wasi-http`'s default
/// implementation, which does not export it. An invalid name maps to the
/// DNS error the default `p3_error_from_dns` hook reports.
fn tls_server_name(authority: &str) -> Result<rustls::pki_types::ServerName<'static>, Error> {
    use rustls::pki_types::ServerName;

    if let Ok(addr) = authority.parse::<std::net::SocketAddr>() {
        return Ok(ServerName::from(addr.ip()));
    }
    let host = match authority.split_once(':') {
        Some((host, _port)) => host,
        None => authority,
    };
    ServerName::try_from(host)
        .map(|name| name.to_owned())
        .map_err(|_| Error::DnsError {
            rcode: Some("invalid dns name".to_string()),
            info_code: None,
        })
}

/// A client connection, with or without TLS.
enum Stream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl Connection for Stream {
    fn connected(&self) -> Connected {
        match self {
            Stream::Plain(_) => Connected::new(),
            Stream::Tls(stream) => {
                if stream.get_ref().1.alpn_protocol() == Some(b"h2") {
                    Connected::new().negotiated_h2()
                } else {
                    Connected::new()
                }
            }
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write_vectored(cx, bufs),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Stream::Plain(s) => s.is_write_vectored(),
            Stream::Tls(s) => s.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{HeaderMap, HeaderValue, Method, Version};
    use http_body_util::{Empty, Full};
    use hyper::body::Incoming;
    use std::convert::Infallible;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    type ServerBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

    /// A local server and the number of TCP connections it has accepted.
    struct TestServer {
        addr: SocketAddr,
        accepted: Arc<AtomicUsize>,
    }

    impl TestServer {
        fn accepted(&self) -> usize {
            self.accepted.load(Ordering::SeqCst)
        }
    }

    /// Answers with the protocol version it saw, in a header and in the
    /// body, and with trailers that echo the request's `x-request-trailer`
    /// trailer. `/slow` waits ten seconds before answering.
    async fn handle(req: Request<Incoming>) -> Result<Response<ServerBody>, Infallible> {
        let version = format!("{:?}", req.version());
        if req.uri().path() == "/slow" {
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        let collected = req.into_body().collect().await.unwrap();
        let echo = collected
            .trailers()
            .and_then(|t| t.get("x-request-trailer").cloned())
            .unwrap_or(HeaderValue::from_static("none"));
        let received = collected.to_bytes().len();
        let mut trailers = HeaderMap::new();
        trailers.insert("grpc-status", HeaderValue::from_static("0"));
        trailers.insert("x-request-trailer", echo);
        let body = Full::new(Bytes::from(format!("{version} received {received}")))
            .with_trailers(async move { Some(Ok(trailers)) })
            .boxed();
        Ok(Response::builder()
            .header("x-version", version)
            .body(body)
            .unwrap())
    }

    /// A TLS server for `localhost` offering `h2` and `http/1.1`, and the
    /// root store that trusts its self-signed certificate.
    async fn tls_server() -> (TestServer, rustls::RootCertStore) {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let cert = certified.cert.der().clone();
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key.into())
        .unwrap();
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
                    let io = TokioIo::new(tls);
                    let service = hyper::service::service_fn(handle);
                    if h2 {
                        let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                            .serve_connection(io, service)
                            .await;
                    } else {
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, service)
                            .await;
                    }
                });
            }
        });

        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert).unwrap();
        (TestServer { addr, accepted }, roots)
    }

    /// A plain-TCP server that speaks HTTP/2 only, with prior knowledge
    /// (h2c), as a local gRPC server or emulator does.
    async fn h2c_server() -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(tcp), hyper::service::service_fn(handle))
                        .await;
                });
            }
        });
        TestServer { addr, accepted }
    }

    /// A plain-TCP server that speaks HTTP/1.1 only.
    async fn plain_server() -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tcp), hyper::service::service_fn(handle))
                        .await;
                });
            }
        });
        TestServer { addr, accepted }
    }

    fn empty_body() -> WasiBody {
        Empty::new()
            .map_err(|e: Infallible| -> Error { match e {} })
            .boxed_unsync()
    }

    fn get(uri: String) -> Request<WasiBody> {
        Request::builder().uri(uri).body(empty_body()).unwrap()
    }

    /// Sends `req` through the hooks the way `wasmtime-wasi-http` does,
    /// driving the I/O future the hook hands back.
    async fn send(
        hooks: &mut HttpHooks,
        req: Request<WasiBody>,
        options: Option<RequestOptions>,
    ) -> Result<Response<WasiBody>, Error> {
        let fut = hooks.send_request(req, options, Box::new(async { Ok(()) }));
        let (response, io) = Box::into_pin(fut).await?;
        Box::into_pin(io).await?;
        Ok(response)
    }

    async fn body_text(response: Response<WasiBody>) -> String {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn https_negotiates_h2_and_reuses_one_connection() {
        let (server, roots) = tls_server().await;
        let mut hooks = HttpHooks::new(HttpClient::with_roots(roots));
        let uri = format!("https://localhost:{}/", server.addr.port());

        for _ in 0..2 {
            let response = send(&mut hooks, get(uri.clone()), None).await.unwrap();
            assert_eq!(response.version(), Version::HTTP_2);
            assert_eq!(response.headers()["x-version"], "HTTP/2.0");
            assert_eq!(body_text(response).await, "HTTP/2.0 received 0");
        }
        assert_eq!(server.accepted(), 1);
    }

    #[tokio::test]
    async fn trailers_pass_through_both_ways() {
        let (server, roots) = tls_server().await;
        let mut hooks = HttpHooks::new(HttpClient::with_roots(roots));
        let mut request_trailers = HeaderMap::new();
        request_trailers.insert("x-request-trailer", HeaderValue::from_static("sent"));
        let body = Full::new(Bytes::from_static(b"hello"))
            .with_trailers(async move { Some(Ok(request_trailers)) })
            .map_err(|e: Infallible| -> Error { match e {} })
            .boxed_unsync();
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("https://localhost:{}/", server.addr.port()))
            .body(body)
            .unwrap();

        let response = send(&mut hooks, req, None).await.unwrap();
        assert_eq!(response.version(), Version::HTTP_2);
        let collected = response.into_body().collect().await.unwrap();
        let trailers = collected.trailers().cloned().expect("response trailers");
        assert_eq!(trailers["grpc-status"], "0");
        assert_eq!(trailers["x-request-trailer"], "sent");
        assert_eq!(collected.to_bytes(), "HTTP/2.0 received 5");
    }

    #[tokio::test]
    async fn http_uses_http1_and_reuses_one_connection() {
        let server = plain_server().await;
        let mut hooks = HttpHooks::default();
        let uri = format!("http://127.0.0.1:{}/", server.addr.port());

        for _ in 0..2 {
            let response = send(&mut hooks, get(uri.clone()), None).await.unwrap();
            assert_eq!(response.version(), Version::HTTP_11);
            assert_eq!(body_text(response).await, "HTTP/1.1 received 0");
            // An HTTP/1.1 connection goes back to the pool from a task on
            // the background runtime once the body has been read; give it
            // time to land so the next request finds it.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(server.accepted(), 1);
    }

    fn grpc_post(uri: String, content_type: &'static str) -> Request<WasiBody> {
        let body = Full::new(Bytes::from_static(b"\0\0\0\0\0"))
            .map_err(|e: Infallible| -> Error { match e {} })
            .boxed_unsync();
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header("content-type", content_type)
            .header("te", "trailers")
            .body(body)
            .unwrap()
    }

    #[tokio::test]
    async fn http_grpc_uses_h2c_with_trailers_and_reuses_one_connection() {
        let server = h2c_server().await;
        let mut hooks = HttpHooks::default();
        let uri = format!("http://127.0.0.1:{}/pkg.Service/Method", server.addr.port());

        for content_type in ["application/grpc", "application/grpc+proto"] {
            let response = send(&mut hooks, grpc_post(uri.clone(), content_type), None)
                .await
                .unwrap();
            assert_eq!(response.version(), Version::HTTP_2);
            let collected = response.into_body().collect().await.unwrap();
            let trailers = collected.trailers().cloned().expect("response trailers");
            assert_eq!(trailers["grpc-status"], "0");
            assert_eq!(collected.to_bytes(), "HTTP/2.0 received 5");
        }
        assert_eq!(server.accepted(), 1);
    }

    #[test]
    fn only_http_grpc_requests_use_h2c() {
        let grpc = |uri: &str, content_type: &'static str| {
            is_cleartext_grpc(&grpc_post(uri.to_string(), content_type))
        };
        assert!(grpc("http://localhost:8080/a/B", "application/grpc"));
        assert!(grpc("http://localhost:8080/a/B", "application/grpc+proto"));
        assert!(grpc("http://localhost:8080/a/B", "Application/GRPC"));
        assert!(!grpc("https://localhost:8080/a/B", "application/grpc"));
        assert!(!grpc("http://localhost:8080/a/B", "application/grpc-web"));
        assert!(!grpc("http://localhost:8080/a/B", "application/x-protobuf"));
        assert!(!is_cleartext_grpc(&get(
            "http://localhost:8080/".to_string()
        )));
    }

    #[tokio::test]
    async fn untrusted_certificate_is_a_tls_error() {
        let (server, _roots) = tls_server().await;
        let mut hooks = HttpHooks::new(HttpClient::with_roots(rustls::RootCertStore::empty()));
        let uri = format!("https://localhost:{}/", server.addr.port());
        let result = send(&mut hooks, get(uri), None).await;
        assert!(matches!(result, Err(Error::Tls(_))), "{result:?}");
    }

    #[tokio::test]
    async fn refused_connection_is_a_connect_error() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let mut hooks = HttpHooks::default();
        let result = send(&mut hooks, get(format!("http://127.0.0.1:{port}/")), None).await;
        assert!(matches!(result, Err(Error::Connect(_))), "{result:?}");
    }

    #[test]
    fn only_internet_addresses_are_public() {
        let public = |text: &str| is_public(text.parse().unwrap());
        for address in [
            "93.184.216.34",
            "8.8.8.8",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ] {
            assert!(public(address), "{address}");
        }
        for address in [
            "0.0.0.0",
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::1",
            "100::1",
        ] {
            assert!(!public(address), "{address}");
        }
    }

    #[test]
    fn the_policy_comes_from_the_environment() {
        let open = EgressPolicy::from_vars(None, None);
        assert!(!open.deny_private);
        let closed = EgressPolicy::from_vars(
            Some("1".into()),
            Some(" metadata.google.internal , Example.COM".into()),
        );
        assert!(closed.deny_private);
        assert!(closed.exempts("metadata.google.internal"));
        assert!(closed.exempts("example.com"));
        assert!(!closed.exempts("example.org"));
        assert!(!EgressPolicy::from_vars(Some("0".into()), None).deny_private);
    }

    #[tokio::test]
    async fn a_private_address_is_prohibited_unless_its_host_is_exempt() {
        let server = plain_server().await;
        let uri = format!("http://127.0.0.1:{}/", server.addr.port());
        let deny = |allowed: Vec<String>| {
            HttpHooks::new(HttpClient::with_egress(
                rustls::RootCertStore::empty(),
                EgressPolicy {
                    deny_private: true,
                    allowed,
                },
            ))
        };
        let result = send(&mut deny(vec![]), get(uri.clone()), None).await;
        assert!(
            matches!(result, Err(Error::DestinationIpProhibited)),
            "{result:?}"
        );
        // A name is resolved and checked too: localhost is loopback.
        let by_name = format!("http://localhost:{}/", server.addr.port());
        let result = send(&mut deny(vec![]), get(by_name), None).await;
        assert!(
            matches!(result, Err(Error::DestinationIpProhibited)),
            "{result:?}"
        );
        assert_eq!(server.accepted(), 0);
        let allowed = send(&mut deny(vec!["127.0.0.1".into()]), get(uri.clone()), None).await;
        assert_eq!(allowed.unwrap().status(), 200);
        let open = send(&mut HttpHooks::default(), get(uri), None).await;
        assert_eq!(open.unwrap().status(), 200);
    }

    #[tokio::test]
    async fn first_byte_timeout_is_a_read_timeout() {
        let server = plain_server().await;
        let mut hooks = HttpHooks::default();
        let options = RequestOptions {
            first_byte_timeout: Some(Duration::from_millis(200)),
            ..Default::default()
        };
        let uri = format!("http://127.0.0.1:{}/slow", server.addr.port());
        let result = send(&mut hooks, get(uri), Some(options)).await;
        assert!(
            matches!(result, Err(Error::ConnectionReadTimeout)),
            "{result:?}"
        );
    }
}
