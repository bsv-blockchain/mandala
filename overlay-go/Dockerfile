# Built by overlay-go/docker-compose.yml (local) and
# .github/workflows/docker-publish.yml (GHCR).
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
