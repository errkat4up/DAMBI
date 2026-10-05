FROM rust:1.96-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --manifest-path crates/policy-server/Cargo.toml --locked --release -p policy-server

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=builder /app/crates/policy-server/target/release/policy-server /usr/local/bin/policy-server
COPY --from=builder /app/crates/policy-server/target/release/sync_worker   /usr/local/bin/dambi-sync-worker
COPY --from=builder /app/crates/policy-server/target/release/migrate       /usr/local/bin/policy-server-migrate
# Host API-key minting for POST /v1/audit. Ships in the image so an operator can
# run it as a one-off Cloud Run job with the service's own DATABASE_URL instead
# of needing direct database access from a laptop.
COPY --from=builder /app/crates/policy-server/target/release/issue_api_key /usr/local/bin/issue-api-key
# A4 pair: migrations must live in the runtime image; the compile-time path is absent here.
COPY crates/policy-server/db/migrations               /app/migrations
ENV POLICY_DB_MIGRATIONS_DIR=/app/migrations
# Sync config must ship in the image too. Under Helm this is mounted from
# configmap-sync.yaml, but Cloud Run has no ConfigMap — without this the
# default DAMBI_SYNC_CONFIG=/app/dambi-sync.toml is absent and readiness
# fails whenever REQUIRE_SYNC_CONFIG=true.
COPY dambi-sync.toml                                  /app/dambi-sync.toml
USER 10001
ENV POLICY_SERVER_ADDR=0.0.0.0:8788
EXPOSE 8788
CMD ["policy-server"]
