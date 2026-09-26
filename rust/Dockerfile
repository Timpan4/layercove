# layercove-rs image (ADR 0002). Build context: rust/
FROM rust:1.98.1-slim-trixie AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked --bin layercove-rs

# nonroot (uid 65532), no shell or package manager; runs read-only.
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=build /src/target/release/layercove-rs /usr/local/bin/layercove-rs
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/layercove-rs"]
