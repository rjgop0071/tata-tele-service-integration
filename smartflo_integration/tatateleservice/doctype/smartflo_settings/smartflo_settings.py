import frappe
import requests
from frappe import _
from frappe.model.document import Document


# =========================================================
# DOCTYPE CLASS — Frappe requires this to exist
# DO NOT remove or modify this class
# =========================================================
class SmartfloSettings(Document):
    pass


# =========================================================
# SMARTFLO HEADER BUILDER
# =========================================================
def get_smartflo_headers():
    settings = frappe.get_single("Smartflo Settings")

    token = settings.access_token
    if not token:
        frappe.throw(_("Smartflo Access Token not configured."))

    if not token.startswith("Bearer "):
        token = f"Bearer {token}"

    return {
        "Authorization": token,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }


# =========================================================
# CLICK TO CALL
# =========================================================
@frappe.whitelist()
def smartflo_click_to_call(destination_number, agent_number=None, caller_id=None):
    try:
        settings = frappe.get_single("Smartflo Settings")

        if not settings.api_base_url:
            frappe.throw(_("Smartflo API Base URL not configured."))

        headers = get_smartflo_headers()
        url = f"{settings.api_base_url}/v1/click_to_call"

        agent = agent_number or settings.default_agent_number
        caller = caller_id or settings.default_caller_id

        if not agent:
            frappe.throw(_("Agent number not configured."))
        if not caller:
            frappe.throw(_("Caller ID not configured."))

        payload = {
            "async": 0,
            "agent_number": agent,
            "destination_number": destination_number,
            "caller_id": caller
        }

        response = requests.post(url, json=payload, headers=headers, timeout=30)
        frappe.log_error(response.text, "Smartflo ClickToCall Response")

        if response.status_code != 200:
            frappe.throw(_("Smartflo API Error: {0}").format(response.status_code))

        return {"status": "success", "data": response.json()}

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Smartflo ClickToCall Error")
        frappe.throw(_("Click-to-call failed"))


# =========================================================
# LIVE CALL SYNC
# =========================================================
@frappe.whitelist()
def smartflo_sync_live_calls(agent_number=None):
    try:
        settings = frappe.get_single("Smartflo Settings")

        if not settings.api_base_url:
            frappe.throw(_("Smartflo API Base URL not configured."))

        headers = get_smartflo_headers()
        agent = agent_number or settings.default_agent_number

        if not agent:
            frappe.throw(_("Agent number not configured."))

        url = f"{settings.api_base_url}/v1/live_calls?agent_number={agent}"
        response = requests.get(url, headers=headers, timeout=30)

        if response.status_code != 200:
            frappe.throw(_("Smartflo API Error: {0}").format(response.status_code))

        json_data = response.json()
        frappe.log_error(json_data, "Smartflo Live Calls Raw")

        calls = json_data if isinstance(json_data, list) else json_data.get("data", [])

        inserted = 0
        latest_call_id = None

        for call in calls:
            call_id = call.get("call_id")
            if not call_id:
                continue

            latest_call_id = call_id

            if frappe.db.exists("Smartflo Call Log", {"call_id": call_id}):
                continue

            doc = frappe.new_doc("Smartflo Call Log")
            doc.call_id = call_id
            doc.direction = call.get("direction")
            doc.agent_number = call.get("source")
            doc.customer_number = call.get("customer_number") or call.get("destination")
            doc.did = call.get("did")
            doc.state = call.get("state")
            doc.created_at = call.get("created_at")
            doc.call_time = call.get("call_time")
            doc.agent_name = call.get("agent_name")
            doc.raw_json = frappe.as_json(call)

            doc.insert(ignore_permissions=True)
            inserted += 1

        frappe.db.commit()

        return {
            "status": "success",
            "inserted": inserted,
            "total_received": len(calls),
            "latest_call_id": latest_call_id
        }

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Smartflo Live Call Sync Error")
        frappe.throw(_("Live call sync failed"))


# =========================================================
# HANGUP ACTIVE CALL
# =========================================================
@frappe.whitelist()
def smartflo_hangup_call(call_id: str):
    try:
        settings = frappe.get_single("Smartflo Settings")

        if not settings.api_base_url:
            frappe.throw(_("Smartflo API Base URL not configured."))

        headers = get_smartflo_headers()
        url = f"{settings.api_base_url}/v1/call/hangup"

        response = requests.post(
            url,
            json={"call_id": call_id},
            headers=headers,
            timeout=30
        )

        frappe.log_error(response.text, "Smartflo Hangup Response")

        if response.status_code != 200:
            frappe.throw(_("Hangup failed ({0})").format(response.status_code))

        return {"status": "success"}

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Smartflo Hangup Error")
        frappe.throw(_("Call hangup failed"))


# =========================================================
# FINAL CALL RECORD SYNC (SMARTFLO → FRAPPE)
# =========================================================
@frappe.whitelist()
def smartflo_sync_call_record(call_id: str):
    try:
        settings = frappe.get_single("Smartflo Settings")

        if not settings.api_base_url:
            frappe.throw(_("Smartflo API Base URL not configured."))

        headers = get_smartflo_headers()
        url = f"{settings.api_base_url}/v1/call/records?call_id={call_id}"

        response = requests.get(url, headers=headers, timeout=30)

        if response.status_code != 200:
            frappe.throw(_("Smartflo Record API Error: {0}").format(response.status_code))

        json_data = response.json()
        frappe.log_error(json_data, "Smartflo Records Raw")

        records = json_data.get("results", [])

        if not records:
            return {"status": "no_record"}

        rec = records[0]
        call_id_val = rec.get("call_id")

        if frappe.db.exists("Smartflo Call Record", {"call_id": call_id_val}):
            return {"status": "exists"}

        start_time = None
        if rec.get("date") and rec.get("time"):
            start_time = f"{rec.get('date')} {rec.get('time')}"

        doc = frappe.new_doc("Smartflo Call Record")
        doc.call_id = call_id_val
        doc.agent_number = rec.get("agent_number")
        doc.customer_number = rec.get("client_number")
        doc.did = rec.get("did_number")
        doc.direction = rec.get("direction")
        doc.state = rec.get("status")
        doc.start_time = start_time
        doc.end_time = rec.get("end_stamp")
        doc.duration = rec.get("call_duration")
        doc.agent_name = rec.get("agent_name")
        doc.recording_url = rec.get("recording_url")
        doc.raw_json = frappe.as_json(rec)

        doc.insert(ignore_permissions=True)
        frappe.db.commit()

        return {"status": "inserted", "record_saved": True}

    except Exception:
        frappe.log_error(frappe.get_traceback(), "Smartflo Call Record Sync Error")
        frappe.throw(_("Call record sync failed"))
