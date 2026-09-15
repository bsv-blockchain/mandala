# Build context is the repo root (app depends on ../lib via file:../lib).
#   docker build -f app/Dockerfile --build-arg VITE_OVERLAY_URL=... .
FROM node:22-alpine AS build
WORKDIR /src

# Install lib deps without running its `prepare` build (sources not copied yet).
COPY lib/package.json lib/package-lock.json lib/
RUN cd lib && npm ci --ignore-scripts
COPY lib lib
RUN cd lib && npm run build

# App: `file:../lib` resolves to the freshly built lib above.
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --ignore-scripts
COPY app app

# Vite bakes VITE_* into the bundle at build time; process env overrides any .env file.
ARG VITE_OVERLAY_URL
ARG VITE_OVERLAY_IDENTITY_KEY
ARG VITE_MESSAGEBOX_URL
ARG VITE_ADMIN_API_TOKEN=
ENV VITE_OVERLAY_URL=$VITE_OVERLAY_URL \
    VITE_OVERLAY_IDENTITY_KEY=$VITE_OVERLAY_IDENTITY_KEY \
    VITE_MESSAGEBOX_URL=$VITE_MESSAGEBOX_URL \
    VITE_ADMIN_API_TOKEN=$VITE_ADMIN_API_TOKEN
RUN cd app && npm run build

FROM nginx:1.28-alpine
COPY app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/app/dist /usr/share/nginx/html
EXPOSE 8080
