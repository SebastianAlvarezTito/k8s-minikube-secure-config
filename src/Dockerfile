# Imagen ligera y reproducible del backend (S08 | AP6)
FROM node:20-alpine

# Directorio de trabajo dentro del contenedor
WORKDIR /app

# Se copian primero los manifiestos de dependencias para aprovechar la caché de capas
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código fuente de la aplicación
COPY server.js ./

# El puerto real lo define APP_PORT (ConfigMap); 3000 es solo documentación
EXPOSE 3000

# UID numérico 1000 = usuario "node": no se ejecuta como root
USER 1000

CMD ["node", "server.js"]
