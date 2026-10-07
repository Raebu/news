FROM node:22.16.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY types ./types
COPY db ./db
COPY docs ./docs
USER node
EXPOSE 8787
ENV RAEBURN_START_SERVER=true
CMD ["node","--experimental-strip-types","apps/api/src/server.ts"]
