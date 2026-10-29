# SilverBullet server proxy patch

`silverbullet-proxy-schemes.patch` targets `silverbulletmd/silverbullet` commit `4f9edf885354e5cc28b4c1ceaebf40aec3eaa319`. It preserves explicitly supplied HTTP and HTTPS schemes and adds an authenticated, write-authorised `OPTIONS /.proxy/` capability probe. Legacy proxy URLs retain their existing behaviour. Read-only mode still disables proxy access.

Apply it in a SilverBullet server checkout at that revision:

```sh
git apply --check /path/to/silverbullet-ai/patches/silverbullet-proxy-schemes.patch
git apply /path/to/silverbullet-ai/patches/silverbullet-proxy-schemes.patch
cargo test -p silverbullet-server handlers::proxy --locked
cargo test -p silverbullet-server capability_routes_require_write --locked
```

The plug checks the capability before sending provider credentials for URLs that the legacy proxy would misroute. A server without this capability retains the existing rejection and direct-connection guidance. The patch must be built and deployed separately to enable these URLs through the proxy. No deployment or upstream submission is performed by the plug build.

Conditional HTTP file writes already exist in this server revision: `PUT /.fs/<path>` accepts `If-Match` and `If-None-Match`, checked under the server's path lock. The plug's `space.writePage` syscall does not expose that operation. This patch does not bypass SilverBullet's local space and sync workflow to perform direct HTTP writes. Approved edits therefore retain the local content check and its documented external-edit race.

## Conditional-write draft

`silverbullet-conditional-writes-draft.patch` targets the same core revision and is unfinished. It contains the conditional commit and recovery protocol, shared file locks, a service-worker route, permission and event wrappers, a syscall and a server capability header. The plug does not use the new API yet. This draft is retained for continued development, not deployment.

The upstream TypeScript check and 207 affected tests pass. Complete route and real-server tests, explicit manual recovery, external filesystem race tests and final patch applicability checks remain outstanding. See the [research record](../docs/research/agent-runtime-improvements.md) and [implementation plan](../docs/plans/agent-runtime-improvements.md) for scope and evidence.
