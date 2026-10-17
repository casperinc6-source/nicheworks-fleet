# The whole NICHEWORKS fleet in one image.
#
# fuse-hub spawns every sibling app as a child process and reverse-proxies to
# them, so this image exposes a single port (4000) serving all 25 apps.
# The apps have ZERO runtime dependencies — there is nothing to npm install.
FROM node:22-slim

WORKDIR /app

# Copy the fleet (see .dockerignore for what is left out).
COPY . .

ENV NODE_ENV=production \
    PORT=4000 \
    FLEET_DATA_DIR=/app/data

# Each app writes /app/<app>/data; the volume is mounted once at /app/data.
# The entrypoint links every app's data dir into it so a restart keeps the
# ledgers (see the script for why this is not optional).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
VOLUME ["/app/data"]

EXPOSE 4000

# The hub's own /healthz reports how many apps are up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "fuse-hub/server.js"]
