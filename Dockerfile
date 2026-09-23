FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Volumen de datos: sin esto, cada redeploy borraría leads/citas/solicitudes
# ya registrados. Es un almacén JSON de validación (Sección 25.2), no la
# fuente maestra definitiva.
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]
