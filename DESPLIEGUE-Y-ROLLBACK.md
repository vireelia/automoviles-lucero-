# Despliegue y rollback — rama `fase1-motor-conversion`

Preparado el 09/11/2026. **Nada de esto se ha ejecutado en producción.**

## 1. Estado de producción en el momento de preparar esto

- Servicio: EasyPanel, proyecto `virelia-hub`, servicio `lucero`
  (`https://virelia-hub-lucero.lzc0bh.easypanel.host`).
- Commit desplegado: `830609d` (cortafuegos de gasto diario).
- Las claves de OpenAI están agotadas desde el 05/11 14:05 (último registro
  real en `llm_usage_logs`); los errores `llm_http_429` empiezan el 04/11.
- `WHATSAPP_SOLO_RESPONDER_A` sigue activo (74 avisos de "modo de prueba",
  18 solo el 09/11).
- El envío automático de correo (`email_auto_send`) sigue **encendido**: la
  cola del tope diario del 06/11 mantiene 386 correos, 375 con el texto de
  disculpa genérica, y se vacía sola hasta 60/día. **Apagarlo antes de
  cualquier otra cosa** desde el CRM → Integraciones.

## 2. Copia de seguridad verificada

Copia completa de los datos de la aplicación, descargada por las rutas
`/debug/*` (solo lectura) el 09/11/2026:

```
~/lucero-backups/2026-11-09_1303/
```

- 25 colecciones, **39.733 registros**, 134 MB.
- Todas se abrieron y validaron como JSON correcto (sin errores de lectura).
- Incluye lo crítico: `leads` (7.120), `appointments` (202),
  `reservations` (7), `chat_conversations` (6.846), `handoffs` (5.760),
  `alerts` (3.136), `email_processed` (2.000), `trash` (841).

**Límite honesto de esta copia:** contiene las colecciones JSON, no los
archivos adjuntos (`whatsapp_media/`, `whatsapp_outbound/`: notas de voz y
fotos reales de clientes). Esos viven en el mismo volumen pero no se
exponen por `/debug`. Para una copia realmente completa hace falta además
la copia de volumen de EasyPanel (programación `cmw3z2hws00j806p734ek68bv`),
que **no he podido verificar en esta sesión** porque no tengo el token de
EasyPanel en contexto. Conviene confirmar en el panel que su última
ejecución está en "done" antes de desplegar.

**Contiene datos personales reales de clientes.** Está fuera del repositorio
a propósito y no se sube a git.

### Restaurar los datos

El volumen se monta en `/app/data` (variable `DATA_DIR`). Para restaurar una
colección concreta basta con copiar su `.json` dentro de esa carpeta y
reiniciar el servicio: el almacén lee los archivos tal cual. No hay
migraciones ni esquema, así que no hay nada irreversible que deshacer.

## 3. Orden de despliegue

Los tres interruptores nuevos vienen **apagados**. Desplegar no cambia por
sí solo el comportamiento de cara al cliente, salvo las correcciones de
fiabilidad (que son las que interesan).

1. Apagar `email_auto_send` en el CRM (para el goteo de disculpas).
2. Recargar crédito de OpenAI.
3. Desplegar esta rama (`deployAppService` en EasyPanel).
4. Comprobar `/debug/llm_usage_resumen` y `/debug/alerts`: ninguna disculpa
   nueva, ninguna avalancha de pendientes.
5. Probar con un número propio, con `WHATSAPP_SOLO_RESPONDER_A` todavía puesto.
6. Quitar `WHATSAPP_SOLO_RESPONDER_A`.
7. Limpiar el ruido acumulado: `POST /admin/archive_ia_outage_handoffs?dry=1`
   primero (solo cuenta), y sin `dry` después. Archiva 5.511 pendientes del
   apagón y deja intactos los 244 reales. No borra nada.
8. Solo después, y de uno en uno:
   `LUCERO_FIRST_CONTACT_ENABLED=1` → observar un día →
   `LUCERO_CHAT_MODEL_SIMPLE=gpt-4.1-nano` → observar →
   `LUCERO_FOLLOWUP_ENABLED=1`.

## 4. Rollback

| Qué falla | Cómo se revierte | Tiempo |
|---|---|---|
| Un interruptor nuevo da problemas | Quitar la variable de entorno y redesplegar | ~2 min |
| Algo del código nuevo | Redesplegar el commit `830609d` | ~5 min |
| Datos corrompidos | Copiar los `.json` de `~/lucero-backups/2026-11-09_1303/` a `/app/data` y reiniciar | ~10 min |
| Pendientes archivados por error | Son `status:"done"` con una nota, no borrados: se vuelven a poner en `requested` desde el propio JSON | ~5 min |

No hay migraciones de base de datos ni cambios de esquema, así que el
rollback de código es un redespliegue limpio, sin pasos intermedios.

## 5. Riesgos conocidos que quedan

- **Bloqueo entre procesos**: los bloqueos nuevos son archivos en el propio
  volumen (`DATA_DIR/.locks`). Protegen entre procesos de la misma máquina y
  sobreviven a un reinicio, pero no servirían entre dos máquinas distintas
  con volúmenes separados. Hoy EasyPanel corre una sola réplica.
- **Serialización parcial**: el reclamo atómico (`claimOnce`) cubre la
  deduplicación de los tres webhooks y `mutateCollection` las escrituras que
  pasan por ahí. El resto del código sigue el patrón
  `readCollection` + `writeCollection`, que entre dos procesos es
  "gana el último". Con una sola réplica no es un problema real.
- **El modelo barato (`gpt-4.1-nano`) no se ha probado con tráfico real**,
  solo con un LLM simulado. Por eso va apagado.
- **La reducción del prompt está preparada pero NO activa** (ver
  `propuestas/`). El código sigue cargando el prompt original.
