import frappe
from frappe import _
from frappe.model.document import Document
from frappe.integrations.utils import make_get_request, make_post_request


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
    # Use get_cached_doc for Single doctypes to avoid repeated DB hits
    settings = frappe.get_cached_doc("Smartflo Settings")

    token = settings.access_token
    if not token:
        frappe.throw(_("Smartflo Access Token not configured."))

    if not token.startswith("Bearer "):
        token = f"Bearer {token}"

    return {
        "Authorization": token,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def get_smartflo_settings():
    """Centralised settings fetch with validation."""
    settings = frappe.get_cached_doc("Smartflo Settings")
    if not settings.api_base_url:
        frappe.throw(_("Smartflo API Base URL not configured."))
    return settings


# =========================================================
# CLICK TO CALL
# =========================================================
@frappe.whitelist()
def smartflo_click_to_call(destination_number, agent_number=None, caller_id=None):
    try:
        settings = get_smartflo_settings()
        headers = get_smartflo_headers()

        agent = agent_number or settings.default_agent_number
        caller = caller_id or settings.default_caller_id

        if not agent:
            frappe.throw(_("Agent number not configured."))
        if not caller:
            frappe.throw(_("Caller ID not configured."))

        url = f"{settings.api_base_url}/v1/click_to_call"
        payload = {
            "async": 0,
            "agent_number": agent,
            "destination_number": destination_number,
            "caller_id": caller,
        }

        # Use Frappe's built-in HTTP helper — pass as JSON not form data
        response = make_post_request(url, data=frappe.as_json(payload), headers=headers)

        frappe.log_error("Smartflo ClickToCall Response", frappe.as_json(response))

        return {"status": "success", "data": response}

    except frappe.ValidationError:
        raise
    except Exception:
        frappe.log_error("Smartflo ClickToCall Error", frappe.get_traceback())
        frappe.throw(_("Click-to-call failed. Check Error Log for details."))


# =========================================================
# LIVE CALL SYNC
# =========================================================
@frappe.whitelist()
def smartflo_sync_live_calls(agent_number=None):
    try:
        settings = get_smartflo_settings()
        headers = get_smartflo_headers()

        agent = agent_number or settings.default_agent_number
        if not agent:
            frappe.throw(_("Agent number not configured."))

        url = f"{settings.api_base_url}/v1/live_calls?agent_number={agent}"

        # Use Frappe's built-in HTTP helper instead of raw `requests`
        json_data = make_get_request(url, headers=headers)

        frappe.log_error("Smartflo Live Calls Raw", frappe.as_json(json_data))

        calls = json_data if isinstance(json_data, list) else json_data.get("data", [])

        if not calls:
            return {"status": "success", "inserted": 0, "total_received": 0, "latest_call_id": None}

        # Collect all incoming call_ids to check existence in one DB query
        # Avoids N+1 DB problem by fetching all existing call IDs up front
        incoming_call_ids = [c.get("call_id") for c in calls if c.get("call_id")]

        existing_call_ids = set(
            frappe.get_all(
                "Smartflo Call Log",
                filters={"call_id": ["in", incoming_call_ids]},
                pluck="call_id",
            )
        )

        inserted = 0
        latest_call_id = None

        for call in calls:
            call_id = call.get("call_id")
            if not call_id:
                continue

            latest_call_id = call_id

            if call_id in existing_call_ids:
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
            "latest_call_id": latest_call_id,
        }

    except frappe.ValidationError:
        raise
    except Exception:
        frappe.log_error("Smartflo Live Call Sync Error", frappe.get_traceback())
        frappe.throw(_("Live call sync failed. Check Error Log for details."))


# =========================================================
# HANGUP ACTIVE CALL
# =========================================================
@frappe.whitelist()
def smartflo_hangup_call(call_id: str):
    try:
        settings = get_smartflo_settings()
        headers = get_smartflo_headers()

        url = f"{settings.api_base_url}/v1/call/hangup"

        # Use Frappe's built-in HTTP helper — pass as JSON not form data
        response = make_post_request(url, data=frappe.as_json({"call_id": call_id}), headers=headers)

        frappe.log_error("Smartflo Hangup Response", frappe.as_json(response))

        return {"status": "success"}

    except frappe.ValidationError:
        raise
    except Exception:
        frappe.log_error("Smartflo Hangup Error", frappe.get_traceback())
        frappe.throw(_("Call hangup failed. Check Error Log for details."))


# =========================================================
# FINAL CALL RECORD SYNC (SMARTFLO → FRAPPE)
# =========================================================
@frappe.whitelist()
def smartflo_sync_call_record(call_id: str):
    try:
        settings = get_smartflo_settings()
        headers = get_smartflo_headers()

        url = f"{settings.api_base_url}/v1/call/records?call_id={call_id}"

        # Use Frappe's built-in HTTP helper instead of raw `requests`
        json_data = make_get_request(url, headers=headers)

        frappe.log_error("Smartflo Records Raw", frappe.as_json(json_data))

        records = json_data.get("results", [])
        if not records:
            return {"status": "no_record"}

        rec = records[0]
        call_id_val = rec.get("call_id")

        if frappe.db.exists("Smartflo Call Record", {"call_id": call_id_val}):
            return {"status": "exists"}

        # Safely build start_time only when both fields are present
        start_time = None
        if rec.get("date") and rec.get("time"):
            start_time = f"{rec['date']} {rec['time']}"

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

    except frappe.ValidationError:
        raise
    except Exception:
        frappe.log_error("Smartflo Call Record Sync Error", frappe.get_traceback())
        frappe.throw(_("Call record sync failed. Check Error Log for details."))