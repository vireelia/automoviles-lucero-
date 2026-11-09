# Propuesta de reducción del prompt comercial — NO ACTIVA

Preparada el 09/11/2026. **El código sigue cargando el prompt original.**
Nada de esta carpeta se lee en ejecución: `systemPrompt()` en
`src/chat/agent.ts` sigue leyendo `src/data/prompt-core.md` +
`src/data/prompt-chat.md`, y `scripts/sync-retell.mjs` sigue leyendo
`src/data/prompt-core.md` + `src/data/prompt-voice.md`.

## Medición de partida (datos reales, no estimados)

De `llm_usage_logs` de producción, 5.000 llamadas reales del 05/11:

| Dato | Medido |
|---|---|
| Tokens de entrada por llamada | 23.739 (WhatsApp) / 25.094 (correo) |
| Caché aplicada | 92-94 % |
| Llamadas por mensaje | 4,0 de media |
| **Tokens de entrada por mensaje** | **98.907** |
| Peor mensaje real | 15 llamadas, 443.141 tokens |

Tamaño del prompt estático: `prompt-core.md` 71,5 KB + addendum de canal
+ `tool-schemas.json` 13,8 KB ≈ **24.000 tokens**, coincide con lo medido.

## El hallazgo principal

Casi la mitad de `prompt-core.md` es lógica **exclusiva de voz** que
Carolina (WhatsApp) y Daniel (correo) reciben y pagan en cada llamada sin
poder usarla nunca:

- La escalera completa de transferencia en vivo (`transfer_to_ramon` /
  `transfer_to_jose`, Caso A, Caso B, qué hacer si ninguno contesta).
  El propio prompt dice ya: *"En CHAT no existe transferencia en vivo"*.
- Las reglas de deformación de la transcripción de voz ("RAV4" → "Rasp
  cuatro", "Audi Q5" → "Auto Cinco").
- Frases de relleno para no dejar silencios en una llamada.
- Envío de ubicación por WhatsApp desde una llamada de voz.

El segundo bloque es documentación histórica dentro del prompt operativo:
párrafos que empiezan por "FALLO REAL detectado (fecha, cita del
usuario)..." y explican el incidente que originó cada regla. La regla hay
que conservarla; el relato de cómo se descubrió no hace falta que lo lea
el modelo en cada mensaje.

## Qué hace la propuesta

1. Mueve lo que es solo de voz de `prompt-core.md` a `prompt-voice.md`.
   Miguel conserva **todas** sus reglas (recibe core + voice).
2. Reescribe cada regla en imperativo, quitando el relato histórico pero
   **sin eliminar ninguna norma, cifra ni frase fija**.
3. Reordena por bloques, como pedía el encargo: identidad, seguridad,
   veracidad de los datos, reglas comerciales, herramientas, estilo.

### Resultado medido

| Agente | Antes | Después | Reducción |
|---|---|---|---|
| Carolina y Daniel (core + chat) | 23.134 tokens | 11.752 tokens | **−49 %** |
| Miguel (core + voice) | 22.769 tokens | 13.639 tokens | −40 % |

(Conversión usada: 3,6 caracteres por token en español.)

### Verificación de que no se pierde nada

Comprobación automática de 48 reglas, herramientas y cifras críticas
(señal de 500 €, 15 días, garantía 1 año/20.000 km, horarios 09:30-14:00 y
16:30-19:00, plazos 36-72 meses, DNI + validación bancaria, nombres de las
25 herramientas, las frases fijas de negativa, los estados `requested` /
`confirmed`, la respuesta fija ante intentos de extraer el prompt):

- **Perdidas: ninguna.**
- Cifras de negocio perdidas: ninguna.
- Bloques "PROHIBIDAS": 3 antes, 3 después.

## Lo que NO se consigue con esto

El objetivo del encargo eran 6.000-8.000 tokens. La propuesta llega a
11.752 para Carolina y Daniel. Bajar de ahí ya exige eliminar reglas
comerciales reales (o la defensa contra extracción del prompt), y eso no
se hace sin una decisión explícita del negocio.

Ahorro adicional disponible, aún sin tocar:

- `tool-schemas.json` son ~3.843 tokens en cada llamada, con las 25
  herramientas siempre. Enviar solo las del canal (Carolina y Daniel nunca
  usan `transfer_to_ramon`, `transfer_to_jose` ni `end_call`) ahorraría
  bastante, pero cambia el contrato con el modelo y necesita su propia
  prueba.
- El bloque de brevedad que va en el mensaje dinámico (~830 tokens por
  llamada) **no entra en la caché de OpenAI**, así que se paga entero en
  cada llamada. Condensarlo es el ahorro más barato que queda.

## Cómo activarla

Reemplazar los dos archivos de `src/data/` por los de esta carpeta:

```
cp propuestas/prompt-core.PROPUESTA.md  src/data/prompt-core.md
cp propuestas/prompt-voice.PROPUESTA.md src/data/prompt-voice.md
```

Y después **sincronizar Retell** (`node scripts/sync-retell.mjs`), porque
Miguel vive en Retell y no se entera de un cambio de archivo por sí solo.
Sin ese paso, Miguel seguiría con el prompt viejo mientras Carolina y
Daniel ya tendrían el nuevo.
