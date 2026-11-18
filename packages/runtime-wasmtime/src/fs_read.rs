//! `wasi:filesystem/types#[method]descriptor.read-via-stream` with a
//! larger read size.
//!
//! wasmtime-wasi 48 reads a file 8 KiB at a time, on a fresh blocking
//! task per read (`DEFAULT_BUFFER_CAPACITY` in its `p3` module), and an
//! embedder cannot change that. Streaming a file to an HTTP response
//! then costs about 30 µs per 8 KiB: 64 MB takes 250 ms. Reading
//! 256 KiB at a time takes it to about 14 ms. See
//! https://github.com/elematic/zena/issues/323.
//!
//! [`add_to_linker`] replaces wasmtime-wasi's definition of the one
//! function after `wasmtime_wasi::p3::add_to_linker` has run. Everything
//! else about descriptors stays wasmtime-wasi's: the resource table
//! holds its `Descriptor`, and this only reads the file it wraps. Remove
//! this module once wasmtime lets an embedder set the size.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};

use bytes::BytesMut;
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, spawn_blocking};
use wasmtime::StoreContextMut;
use wasmtime::component::{
    Destination, FutureReader, Linker, Resource, StreamProducer, StreamReader, StreamResult,
};
use wasmtime_wasi::filesystem::Descriptor;
use wasmtime_wasi::p3::bindings::filesystem::types::ErrorCode;

use crate::component::ComponentState;

/// The most bytes read from the file per poll.
const READ_SIZE: usize = 256 * 1024;

/// The fewest: what is left of the file is read in one go when it is
/// smaller than `READ_SIZE`, but never less than this, so a file that
/// has grown since its size was taken is still read, and end of file
/// is still found.
const MIN_READ_SIZE: usize = 8 * 1024;

/// The WIT instance the function belongs to, as the vendored
/// `packages/stdlib/zena/wit/filesystem.wit` names it.
const INSTANCE: &str = "wasi:filesystem/types@0.3.0";

/// Redefines `read-via-stream` in a linker that already holds
/// wasmtime-wasi's p3 filesystem.
pub fn add_to_linker(linker: &mut Linker<ComponentState>) -> wasmtime::Result<()> {
    linker.allow_shadowing(true);
    linker.instance(INSTANCE)?.func_wrap(
        "[method]descriptor.read-via-stream",
        |mut store: StoreContextMut<'_, ComponentState>,
         (fd, offset): (Resource<Descriptor>, u64)|
         -> wasmtime::Result<((StreamReader<u8>, FutureReader<Result<(), ErrorCode>>),)> {
            let file = match store.data().table.get(&fd)? {
                Descriptor::File(file) => Arc::clone(&file.file),
                Descriptor::Dir(_) => {
                    return Ok(((
                        StreamReader::new(&mut store, std::iter::empty())?,
                        FutureReader::new(&mut store, async {
                            wasmtime::error::Ok(Err(ErrorCode::IsDirectory))
                        })?,
                    ),));
                }
            };
            let (result_tx, result_rx) = oneshot::channel();
            // One result, a `tuple<stream<u8>, future<...>>`.
            Ok(((
                StreamReader::new(
                    &mut store,
                    FileReader {
                        file,
                        offset,
                        result: Some(result_tx),
                        task: None,
                    },
                )?,
                FutureReader::new(&mut store, result_rx)?,
            ),))
        },
    )?;
    linker.allow_shadowing(false);
    Ok(())
}

/// A file's contents from `offset`, read on the blocking pool up to
/// `READ_SIZE` bytes at a time (see [`read_size`]). `result` settles the call's future: on
/// end of file, on an error, or when the stream is dropped.
struct FileReader {
    file: Arc<std::fs::File>,
    offset: u64,
    result: Option<oneshot::Sender<Result<(), ErrorCode>>>,
    task: Option<JoinHandle<std::io::Result<BytesMut>>>,
}

impl FileReader {
    fn close(&mut self, result: Result<(), ErrorCode>) {
        if let Some(tx) = self.result.take() {
            let _ = tx.send(result);
        }
    }
}

impl Drop for FileReader {
    fn drop(&mut self) {
        self.close(Ok(()));
    }
}

impl<D> StreamProducer<D> for FileReader {
    type Item = u8;
    type Buffer = BytesMut;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        _store: StoreContextMut<'a, D>,
        mut dst: Destination<'a, Self::Item, Self::Buffer>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        let me = &mut *self;
        let task = me.task.get_or_insert_with(|| {
            let mut buf = dst.take_buffer();
            let file = Arc::clone(&me.file);
            let offset = me.offset;
            spawn_blocking(move || {
                buf.resize(read_size(&file, offset), 0);
                read_at(&file, &mut buf, offset).map(|n| {
                    buf.truncate(n);
                    buf
                })
            })
        });
        // A read in flight cannot be cancelled, so a cancellation request
        // aborts the task (which only helps if it has not started) and
        // still waits for it.
        let result = match Pin::new(&mut *task).poll(cx) {
            Poll::Pending if finish => {
                task.abort();
                ready!(Pin::new(task).poll(cx))
            }
            other => ready!(other),
        };
        self.task = None;
        match result {
            Ok(Ok(buf)) if buf.is_empty() => {
                self.close(Ok(()));
                Poll::Ready(Ok(StreamResult::Dropped))
            }
            Ok(Ok(buf)) => {
                let n = buf.len() as u64;
                dst.set_buffer(buf);
                match self.offset.checked_add(n) {
                    Some(next) => {
                        self.offset = next;
                        Poll::Ready(Ok(StreamResult::Completed))
                    }
                    None => {
                        self.close(Err(ErrorCode::Overflow));
                        Poll::Ready(Ok(StreamResult::Dropped))
                    }
                }
            }
            Ok(Err(err)) => {
                self.close(Err(err.into()));
                Poll::Ready(Ok(StreamResult::Dropped))
            }
            Err(err) if err.is_cancelled() => Poll::Ready(Ok(StreamResult::Cancelled)),
            Err(err) => panic!("file read task panicked: {err}"),
        }
    }
}

/// How many bytes to read at `offset`: what is left of the file,
/// between `MIN_READ_SIZE` and `READ_SIZE`. A small file then holds a
/// buffer its own size rather than `READ_SIZE`, which matters when many
/// are being sent at once. The size comes from an `fstat` per read; if
/// that fails the read is `READ_SIZE`, and the read reports any error.
fn read_size(file: &std::fs::File, offset: u64) -> usize {
    let left = match file.metadata() {
        Ok(meta) => meta.len().saturating_sub(offset),
        Err(_) => READ_SIZE as u64,
    };
    usize::try_from(left)
        .unwrap_or(READ_SIZE)
        .clamp(MIN_READ_SIZE, READ_SIZE)
}

/// One positioned read, retried on interruption.
#[cfg(unix)]
fn read_at(file: &std::fs::File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    loop {
        match file.read_at(buf, offset) {
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// One positioned read. `seek_read` moves the file cursor, which
/// `read-via-stream` does not promise to leave alone.
#[cfg(windows)]
fn read_at(file: &std::fs::File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buf, offset)
}
