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

## 2.bis Variables de entorno

### Nuevas en esta rama (las tres vienen APAGADAS)

| Variable | Qué hace | Valor para desplegar |
|---|---|---|
| `LUCERO_FIRST_CONTACT_ENABLED` | Envía de verdad el primer contacto de portales. Apagada, deja el texto como nota en Pendientes | **sin poner** |
| `LUCERO_CHAT_MODEL_SIMPLE` | Modelo económico para consultas informativas (p. ej. `gpt-4.1-nano`). Sin poner, todo usa el modelo capaz | **sin poner** |
| `LUCERO_FOLLOWUP_ENABLED` | Seguimiento comercial (máximo 2, texto fijo) | **sin poner** |
| `LUCERO_MAX_TOOL_ROUNDS` | Tope de rondas de herramientas por mensaje | sin poner = 3 |

### Existentes que importan ahora

| Variable | Estado para desplegar |
|---|---|
| `WHATSAPP_SOLO_RESPONDER_A` | Dejarla puesta para la prueba inicial y **quitarla en el paso 6** |
| `LUCERO_DAILY_LLM_BUDGET_EUR` | Sin poner = 15 € |
| `GMAIL_DAILY_SEND_CAP` | Sin poner = 60 |
| `OPENAI_API_KEY`, `OPENAI_API_KEY_WHATSAPP`, `OPENAI_API_KEY_EMAIL` | **Recargar crédito antes de desplegar** |
| `N8N_VOZ_WEBHOOK_URL` | Sin cambios. Ahora, si falla, el aviso se reintenta y acaba en una tarea en vez de perderse |

No hay variables nuevas obligatorias: la rama se despliega sin tocar ninguna.

## 2.ter Migraciones

**No hay migraciones.** El almacén son archivos JSON sin esquema y todos los
campos nuevos son opcionales (`outcome_by`, `outcome_at` en citas) o
colecciones nuevas que se crean vacías al usarse por primera vez
(`chat_pending_replies`, `followups_comerciales`, `first_contact_sent`,
`n8n_voz_outbox`, `.locks/`). Un rollback de código no deja datos
inservibles: los estados de cita nuevos (`asistio`, `comprado`) simplemente
dejarían de tener botón en el CRM, pero el dato se conserva.

## 3. Orden de despliegue

Los tres interruptores nuevos vienen **apagados**. Desplegar no cambia por
sí solo el comportamiento de cara al cliente, salvo las correcciones de
fiabilidad (que son las que interesan).

1. Recargar crédito de OpenAI.
2. Desplegar esta rama (`deployAppService` en EasyPanel). **El goteo de
   disculpas se corta con el propio despliegue**: el drenaje de la cola ya no
   envía un borrador que sea la disculpa genérica, lo retiene y crea una
   tarea. Ya no hace falta apagar `email_auto_send`, que habría dejado
   también sin enviar los 11 borradores legítimos y sin responder a los
   correos nuevos.
3. Contener de golpe los que ya están en cola, sin esperar al ciclo:
   `POST /admin/retener_borradores_disculpa?dry=1` (solo cuenta) y luego sin
   `dry`. Debe reportar ~375 retenidos y ~11 legítimos intactos.
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

## 4.bis Plan para los 168 WhatsApp y 1.132 correos sin atender

Esto **no es un envío masivo**: es ponerle a Ramón y José una lista para que
decidan y escriban ellos, uno a uno, a su ritmo. El sistema no contacta a
nadie por su cuenta.

1. **Nunca automático.** No existe ningún proceso que reenvíe estos mensajes
   solo. Lo único que toca este atasco es `/admin/archive_ia_outage_handoffs`,
   y solo limpia el RUIDO (los avisos duplicados del fallo de IA), nunca
   envía nada a un cliente.
2. **Lista para el equipo, no cola de envío.** Generar un informe (CSV o
   vista en el CRM) con los 168 WhatsApp y 1.132 correos: teléfono/correo,
   fecha, texto original, y si hay o no una cita/reserva asociada. Ramón y
   José priorizan y contestan desde WhatsApp Web o Gmail directamente, fuera
   del sistema automático.
3. **Sin consumo de IA**: esa lista se genera leyendo `whatsapp_inbox` y
   `email_inbox`, sin volver a llamar a `handleChatMessage` para ninguno de
   ellos. Coste: cero.
4. **Si se quisiera automatizar algún día** (no autorizado, no planeado):
   tendría que ser con el mismo criterio que ya hay para el primer
   contacto -- plantilla fija, deduplicado, con límite por minuto y por día,
   nunca reabriendo IA sobre 1.300 conversaciones muertas de golpe. Eso es
   justo lo que el seguimiento comercial (`LUCERO_FOLLOWUP_ENABLED`) NO hace
   con este atasco: solo actúa sobre conversaciones de los últimos días, no
   sobre este histórico.

## 5. Riesgos conocidos que quedan

- **Bloqueo entre procesos**: los bloqueos son archivos en el propio volumen
  (`DATA_DIR/.locks`). Protegen entre procesos de la misma máquina y
  sobreviven a un reinicio (probado: un bloqueo huérfano de hace 10 minutos
  se rompe por plazo y no deja el sistema colgado). No servirían entre dos
  máquinas con volúmenes separados. Hoy EasyPanel corre una sola réplica.
- **Serialización parcial**: `claimOnce` cubre la deduplicación de los
  webhooks de WhatsApp, Zernio, Facebook y Gmail; `mutateCollection`, las
  escrituras que pasan por ahí; y hay bloqueo propio en citas, programador,
  sondeo de correo y reintento de WhatsApp. El resto del código sigue el
  patrón `readCollection` + `writeCollection`, que entre dos procesos es
  "gana el último". Con una sola réplica no es un problema real.
- **`loginAttempts` del CRM sigue en memoria**: el bloqueo por intentos
  fallidos de acceso se reinicia con el proceso y no se comparte entre
  instancias. Debilita algo la protección contra fuerza bruta, pero no
  afecta a mensajes, citas ni reservas. Pendiente, no bloqueante.
- **`lastCheckedAt` del programador sigue en memoria**: solo lo usa
  `checkTechnicalHealth`, que está desactivado. Al reiniciar, como mucho
  repite una comprobación.
- **El modelo barato (`gpt-4.1-nano`) no se ha probado con tráfico real**,
  solo con un LLM simulado. Por eso va apagado.
- **La reducción del prompt está preparada pero NO activa** (ver
  `propuestas/`). El código sigue cargando el prompt original.
