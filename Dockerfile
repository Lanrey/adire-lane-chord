FROM node:26-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/adire-lane.db
EXPOSE 8080
CMD ["node", "src/index.ts"]
