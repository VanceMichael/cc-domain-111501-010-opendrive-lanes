FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
USER node
CMD ["npm", "run", "demo"]
