# Build context is ./fuelkeeper. CGO is on because the SQLite driver needs it.
FROM golang:1.27-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -o /fuelkeeper ./cmd/fuelkeeper

FROM gcr.io/distroless/base-debian12
COPY --from=builder /fuelkeeper /fuelkeeper
EXPOSE 8090
ENTRYPOINT ["/fuelkeeper"]
