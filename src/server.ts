import express from "express";
import cors from "cors";
import { getBusinessInfo } from "./tools/business.js";
import { searchVehicles, getVehicle } from "./tools/vehicles.js";
import { upsertLead, updateContactPreferences } from "./tools/leads.js";
import { createPurchaseRequest, createServiceRequest, createHandoff } from "./tools/requests.js";
import { getAppointmentSlots, createAppointment } from "./tools/appointments.js";
import { sendInternalSummary, sendVehicleDetails } from "./tools/delivery.js";

const app = express();
app.use(cors());
app.use(express.json());

// Retell envía cada llamada de función personalizada como POST con el
// cuerpo de argumentos directamente (sin envolver en "args"), y también
// puede mandar metadatos de la llamada en cabeceras -- no dependemos de
// eso, cada handler solo usa lo que declara en su JSON schema de Retell.
function route(fn: (args: any) => unknown) {
  return (req: express.Request, res: express.Response) => {
    try {
      res.json(fn(req.body ?? {}));
    } catch (err) {
      res.status(200).json({
        status: "error",
        request_id: crypto.randomUUID(),
        data: null,
        error_code: err instanceof Error ? err.message : "unknown_error",
      });
    }
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/tools/get_business_info", route(() => getBusinessInfo()));
app.post("/tools/search_vehicles", route((a) => searchVehicles(a)));
app.post("/tools/get_vehicle", route((a) => getVehicle(a)));
app.post("/tools/upsert_lead", route((a) => upsertLead(a)));
app.post("/tools/update_contact_preferences", route((a) => updateContactPreferences(a)));
app.post("/tools/create_purchase_request", route((a) => createPurchaseRequest(a)));
app.post("/tools/create_service_request", route((a) => createServiceRequest(a)));
app.post("/tools/create_handoff", route((a) => createHandoff(a)));
app.post("/tools/get_appointment_slots", route(() => getAppointmentSlots()));
app.post("/tools/create_appointment", route((a) => createAppointment(a)));
app.post("/tools/send_internal_summary", route((a) => sendInternalSummary(a)));
app.post("/tools/send_vehicle_details", route((a) => sendVehicleDetails(a)));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Automóviles Lucero backend escuchando en :${port}`));
