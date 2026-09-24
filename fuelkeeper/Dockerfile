# Build context is ./fuelkeeper. CGO is on because the SQLite driver needs it.
FROM golang:1.27-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -o /fuelkeeper ./cmd/fuelkeeper && mkdir -p /data

# Runs as the distroless nonroot user (uid 65532). /data is the working
# directory and the PVC mount point: relative paths (the FK_DB_DSN default
# fuelkeeper.sqlite, a relative sqlite connection_string in the infra yaml)
# resolve there.
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=builder /fuelkeeper /fuelkeeper
COPY --from=builder --chown=65532:65532 /data /data
WORKDIR /data
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/fuelkeeper"]
