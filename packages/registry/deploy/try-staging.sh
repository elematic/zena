# The environment that points zena at the staging App View, for trying
# it out: `source packages/registry/deploy/try-staging.sh` in a shell, then
# `zena pkg login`, `zena pkg publish` and `zena pkg add` there. ZENA_CONFIG_DIR, where
# the sign-in is kept, is left to you: set it to a directory of its own to
# keep a staging sign-in apart from your usual one.
export ZENA_REGISTRY=https://pkg-staging.zena-lang.dev
export ZENA_PLC_DIRECTORY=https://pkg-staging.zena-lang.dev/plc
# Staging's handles are in public DNS. A shell that ran the demo
# (npm run demo -w @zena-lang/registry) still points this at the demo's own
# resolver, which is gone once the demo stops.
unset ZENA_DNS_OVER_HTTPS
