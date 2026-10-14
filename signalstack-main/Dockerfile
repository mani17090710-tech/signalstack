FROM node:22-slim
WORKDIR /app
COPY server.js mailer.js ingest.js ./
COPY lib ./lib
COPY data ./data
COPY public ./public
# SQLite file lives in a volume so it survives restarts/redeploys.
VOLUME ["/data"]
ENV DB=/data/signalstack.db
ENV PORT=3000
ENV NODE_ENV=production
ENV TRUST_PROXY=true
EXPOSE 3000
CMD ["node", "server.js"]
