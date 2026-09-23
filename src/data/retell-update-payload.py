import json

BASE = "https://virelia-hub-lucero.lzc0bh.easypanel.host/tools"

def tool(name, description, params, required):
    return {
        "type": "custom",
        "name": name,
        "description": description,
        "url": f"{BASE}/{name}",
        "speak_during_execution": True,
        "speak_after_execution": True,
        "timeout_ms": 8000,
        "parameters": {
            "type": "object",
            "properties": params,
            "required": required,
        },
    }

S = {"type": "string"}
N = {"type": "number"}

tools = [
    tool("get_business_info", "Devuelve información y políticas aprobadas del negocio (horarios, financiación, trámites, teléfonos).", {}, []),
    tool("search_vehicles", "Busca vehículos en el catálogo por texto libre, marca, modelo, combustible o rango de precio/km.", {
        "query": S, "make": S, "model": S, "fuel": S,
        "max_price_eur": N, "min_price_eur": N, "max_km": N, "page": N,
    }, []),
    tool("get_vehicle", "Devuelve la ficha completa de una unidad por su id interno.", {"id": S}, ["id"]),
    tool("upsert_lead", "Crea o actualiza el registro del interesado (teléfono, nombre, intención, notas).", {
        "phone": S, "name": S, "intent": S, "notes": S, "channel": S,
    }, []),
    tool("update_contact_preferences", "Guarda preferencias de contacto de un interesado (ej. no volver a contactar).", {
        "phone": S, "do_not_contact": {"type": "boolean"}, "preferred_channel": S,
    }, ["phone"]),
    tool("create_purchase_request", "Registra una solicitud de tasación/compra de un vehículo que trae el cliente.", {
        "lead_phone": S, "make": S, "model": S, "year": N, "km": N,
        "condition": S, "known_issues": S, "expected_price_eur": N, "trade_in_vehicle_id": S,
    }, []),
    tool("create_service_request", "Registra una solicitud de trámite (transferencia, cambio de titularidad, baja, informe DGT) o incidencia.", {
        "lead_phone": S, "procedure_type": S, "notes": S,
    }, []),
    tool("get_appointment_slots", "Comprueba huecos reales de agenda (hoy siempre devuelve que no hay agenda conectada).", {}, []),
    tool("create_appointment", "Registra una solicitud de cita (visita, prueba, tasación o reserva comercial). Nunca queda confirmada automáticamente.", {
        "lead_phone": S, "vehicle_id": S,
        "appointment_type": {"type": "string", "enum": ["visita", "prueba", "tasacion", "reserva_comercial"]},
        "requested_date": S, "requested_time": S, "notes": S,
    }, []),
    tool("create_handoff", "Registra una solicitud de atención humana o devolución de llamada.", {
        "lead_phone": S, "reason": S,
        "urgency": {"type": "string", "enum": ["normal", "alta"]}, "notes": S,
    }, []),
    tool("send_internal_summary", "Registra el resumen de la gestión para el equipo. Nunca confirmes al cliente que se envió, solo que quedó registrado.", {
        "summary_text": S,
    }, ["summary_text"]),
    tool("send_vehicle_details", "Registra el envío de la ficha de un vehículo a un canal del cliente.", {
        "lead_phone": S, "vehicle_id": S, "channel": S,
    }, []),
]

general_tools = [{
    "name": "end_call",
    "speak_after_execution": True,
    "type": "end_call",
    "description": "Termina la llamada cuando la conversación ha concluido de forma natural.",
}] + tools

prompt = open("/Users/usuario/automoviles-lucero/src/data/voice-prompt.md", encoding="utf-8").read()

payload = {
    "general_prompt": prompt,
    "general_tools": general_tools,
    "begin_message": "Hola, has llamado a Automóviles Lucero. Soy el asistente virtual. ¿En qué te ayudo?",
}

print(json.dumps(payload))
