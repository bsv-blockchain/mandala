# Build context is ../overlay-go relative to overlay/docker-compose.yml
# (services: `overlay-go`, context: ../overlay-go).
FROM golang:1.26 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /overlay ./cmd/overlay

FROM gcr.io/distroless/static-debian12
COPY --from=builder /overlay /overlay
EXPOSE 8080
ENTRYPOINT ["/overlay"]
