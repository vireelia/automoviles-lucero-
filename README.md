# Automóviles Lucero — Backend

Backend único (Node.js + TypeScript, Express) para un concesionario de coches: agente de IA conversacional ("Miguel") por voz ([Retell](https://retellai.com)), WhatsApp, Facebook Messenger, email y chat web, además de un CRM propio server-rendered y un "Studio" de generación de imagen/vídeo con IA ([Higgsfield](https://higgsfield.ai)).

Documentación completa de arquitectura, convenciones y variables de entorno en [CLAUDE.md](./CLAUDE.md).

## Stack

- Node 22, TypeScript (ESM, `NodeNext`), Express.
- Sin framework de frontend: el CRM y el panel son HTML generado en servidor.
- Persistencia: colecciones JSON planas en disco bajo `DATA_DIR`, pensada para validación — no es la base de datos definitiva.

## Qué hace

- **Agente de IA** que atiende clientes por voz, WhatsApp, Facebook Messenger, email y chat web: busca vehículos, da información del negocio, gestiona citas (Google Calendar), crea leads/reservas/solicitudes de financiación y deriva a una persona cuando hace falta.
- **CRM** (`/crm`) para el equipo humano: hoy/pendientes, citas, reservas, fichas de cliente, gestión de stock, equipo, integraciones y papelera.
- **Studio IA** (`/crm/studio`, solo admin): genera imágenes/vídeos publicitarios de los coches y puede publicarlos directamente en redes sociales vía [Zernio](https://zernio.com).
- **WhatsApp Business** conectable de dos formas: Cloud API directa de Meta, o vía Zernio (Embedded Signup, sin el proceso de verificación de negocio de Meta) — ver detalle en [CLAUDE.md](./CLAUDE.md#2-whatsapp-business-sin-verificación-de-negocio-de-meta).

## Desarrollo

```bash
npm install
cp .env.example .env   # rellena las claves que vayas a usar
npm run dev            # http://localhost:8080
```

```bash
npm run build           # compila a dist/
npm start                # producción (requiere build previo)
```

## Scripts

```bash
node scripts/import-dealcar.mjs <export.xml>   # regenera src/data/vehicles-seed.ts desde el feed de Dealcar
node scripts/sync-retell.mjs                   # sincroniza prompts/tool-schemas con el agente de voz en Retell
```

## Despliegue

Incluye `Dockerfile` (build multi-stage, puerto `80`). Requiere un volumen persistente en `/app/data` — sin él, cada redeploy borraría leads, citas y reservas ya registrados.

## Licencia

Privado — uso interno de Automóviles Lucero.
