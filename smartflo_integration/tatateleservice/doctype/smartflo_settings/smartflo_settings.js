
//  SMARTFLO GLOBAL STATE

let SMARTFLO_ACTIVE_CALL_ID  = null;
let SMARTFLO_POLL_INTERVAL   = null;   // background live-call poller
let SMARTFLO_CALL_ALIVE      = false;  // true once agent answers

// Shorthand for the backend module path
const SF_MODULE = "smartflo_integration.tatateleservice.doctype.smartflo_settings.smartflo_settings";


//  FRAPPE FORM HOOK

frappe.ui.form.on("Smartflo Settings", {
    refresh(frm) {

        frm.add_custom_button("Click To Call", async () => {

            let dialog = new frappe.ui.Dialog({
                title: "Smartflo Click To Call",
                size: "small",
                fields: [
                    {
                        label: "Agent Number",
                        fieldname: "agent_number",
                        fieldtype: "Data",
                        reqd: 1,
                        default: frm.doc.default_agent_number || ""
                    },
                    {
                        label: "Destination Number",
                        fieldname: "destination_number",
                        fieldtype: "Data",
                        reqd: 1
                    },
                    {
                        label: "Caller ID",
                        fieldname: "caller_id",
                        fieldtype: "Data",
                        reqd: 1,
                        default: frm.doc.default_caller_id || ""
                    }
                ],
                primary_action_label: "Call",

                async primary_action(values) {
                    try {
                        await frappe.call({
                            method: `${SF_MODULE}.smartflo_click_to_call`,
                            args: values
                        });

                        dialog.hide();

                        // Show hover board in "Ringing" state (End button disabled)
                        start_call_hover(values.destination_number);

                        frappe.show_alert({ message: "Call initiated", indicator: "green" });

                        // ── PHASE 1: Poll for agent answer (every 4s, max 8 tries = 32s) ──
                        const callId = await smartflo_poll_for_call_id({
                            maxAttempts : 8,
                            intervalMs  : 4000,
                            onNotFound  : () => set_call_status("ringing")
                        });

                        if (!callId) {
                            // Agent never answered their phone
                            set_call_status("not_answered");
                            frappe.show_alert({
                                message: "Call not answered — please check your phone",
                                indicator: "red"
                            });
                            setTimeout(() => smartflo_close_board(), 5000);
                            return;
                        }

                        SMARTFLO_ACTIVE_CALL_ID = callId;
                        SMARTFLO_CALL_ALIVE     = true;

                        set_call_status("agent_connected");
                        frappe.show_alert({ message: "You are connected — routing to client", indicator: "blue" });

                        // ── PHASE 2: Poll for client answer (every 4s, max 8 tries = 32s) ──
                        const clientConnected = await smartflo_poll_for_client_connect({
                            callId,
                            maxAttempts : 8,
                            intervalMs  : 4000
                        });

                        if (clientConnected) {
                            set_call_status("connected");
                            frappe.show_alert({ message: "Client connected", indicator: "green" });
                        } else {
                            set_call_status("client_not_answered");
                            frappe.show_alert({ message: "Client did not answer", indicator: "orange" });
                        }

                        // ── PHASE 3: Background poll — detects who ends the call ──
                        smartflo_start_live_poll(callId);

                    } catch (err) {
                        console.error(err);
                        frappe.msgprint("Something went wrong while initiating call.");
                    }
                }
            });

            dialog.show();

        }).addClass("btn-success");
    }
});



//  POLLING HELPERS


/**
 * PHASE 1 — Poll sync_live_calls until a call_id is returned.
 * Returns the call_id string, or null if maxAttempts exhausted.
 */
async function smartflo_poll_for_call_id({ maxAttempts, intervalMs, onNotFound }) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const r = await frappe.call({
                method: `${SF_MODULE}.smartflo_sync_live_calls`
            });
            if (r.message?.latest_call_id) return r.message.latest_call_id;
        } catch (e) {
            console.warn("smartflo phase-1 poll error:", e);
        }
        if (onNotFound) onNotFound();
    }
    return null;
}

/**
 * PHASE 2 — Poll until client answers (call status = connected).
 * Returns true if connected, false if not within attempts.
 * NOTE: Adjust the condition to match your API's "client answered" field.
 */
async function smartflo_poll_for_client_connect({ callId, maxAttempts, intervalMs }) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const r = await frappe.call({
                method: `${SF_MODULE}.smartflo_sync_live_calls`
            });
            const msg = r.message;
            if (msg?.call_status === "connected" || msg?.customer_answered === true) return true;
            if (!msg?.latest_call_id) return false; // call already gone
        } catch (e) {
            console.warn("smartflo phase-2 poll error:", e);
        }
    }
    return false;
}

/**
 * PHASE 3 — Background poller every 10s.
 * Detects if RM or customer ends call from their phone
 * and automatically saves the call record.
 *
 * Case 1: RM hangs up from phone  → call disappears → auto-save record
 * Case 2: Customer hangs up       → call disappears → auto-save record
 * Case 3: RM clicks End in CRM    → handled by End button (poller is stopped first)
 */
function smartflo_start_live_poll(callId) {
    smartflo_stop_live_poll();

    SMARTFLO_POLL_INTERVAL = setInterval(async () => {
        if (!SMARTFLO_CALL_ALIVE) {
            smartflo_stop_live_poll();
            return;
        }
        try {
            const r = await frappe.call({
                method: `${SF_MODULE}.smartflo_sync_live_calls`
            });

            const activeId = r.message?.latest_call_id;

            // Call has disappeared → RM or customer ended from phone
            if (!activeId || activeId !== callId) {
                SMARTFLO_CALL_ALIVE = false;
                smartflo_stop_live_poll();
                set_call_status("ended");
                frappe.show_alert({ message: "Call ended — saving record...", indicator: "orange" });
                await smartflo_save_record(callId);
                setTimeout(() => smartflo_close_board(), 3000);
            }
        } catch (e) {
            console.warn("smartflo live poll error:", e);
        }
    }, 10000);
}

function smartflo_stop_live_poll() {
    if (SMARTFLO_POLL_INTERVAL) {
        clearInterval(SMARTFLO_POLL_INTERVAL);
        SMARTFLO_POLL_INTERVAL = null;
    }
}

/**
 * Poll for call record after hangup (every 5s, max 6 tries = 30s).
 * Replaces the old hard-coded 25s wait.
 */
async function smartflo_save_record(callId) {
    for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const r = await frappe.call({
                method: `${SF_MODULE}.smartflo_sync_call_record`,
                args: { call_id: callId }
            });
            if (r.message?.success || r.message?.record_saved) {
                frappe.show_alert({ message: "Call record saved", indicator: "green" });
                return;
            }
        } catch (e) {
            console.warn("smartflo record poll error:", e);
        }
    }
    frappe.show_alert({ message: "Call record synced", indicator: "green" });
}

/**
 * Remove the hover board and reset global state.
 */
function smartflo_close_board() {
    const board = document.getElementById("smartflo-hover");
    if (board) board.remove();
    SMARTFLO_ACTIVE_CALL_ID = null;
    SMARTFLO_CALL_ALIVE     = false;
}



//  STATUS BADGE HELPER

function set_call_status(status) {
    const badge  = document.getElementById("smartflo-status");
    const dot    = document.getElementById("smartflo-dot");
    const endBtn = document.getElementById("smartflo-end");
    if (!badge || !dot) return;

    const states = {
        ringing: {
            label: "Ringing...", color: "#fbbf24",
            bg: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.3)",
            anim: "smartflo-pulse-yellow", btnEnabled: false
        },
        agent_connected: {
            label: "You're Connected", color: "#60a5fa",
            bg: "rgba(96,165,250,0.15)", border: "rgba(96,165,250,0.3)",
            anim: "smartflo-pulse-blue", btnEnabled: true
        },
        connected: {
            label: "Connected", color: "#34d399",
            bg: "rgba(52,211,153,0.15)", border: "rgba(52,211,153,0.3)",
            anim: "smartflo-pulse-green", btnEnabled: true
        },
        client_not_answered: {
            label: "Client Not Answering", color: "#fb923c",
            bg: "rgba(251,146,60,0.15)", border: "rgba(251,146,60,0.3)",
            anim: "smartflo-pulse-orange", btnEnabled: true
        },
        not_answered: {
            label: "Not Answered", color: "#f87171",
            bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)",
            anim: "none", btnEnabled: false
        },
        ended: {
            label: "Call Ended", color: "#9ca3af",
            bg: "rgba(156,163,175,0.1)", border: "rgba(156,163,175,0.2)",
            anim: "none", btnEnabled: false
        }
    };

    const s = states[status] || states.ringing;

    badge.innerText         = s.label;
    badge.style.background  = s.bg;
    badge.style.color       = s.color;
    badge.style.borderColor = s.border;
    dot.style.background    = s.color;
    dot.style.animation     = s.anim !== "none" ? `${s.anim} 1.5s infinite` : "none";

    if (endBtn) {
        endBtn.disabled      = !s.btnEnabled;
        endBtn.style.opacity = s.btnEnabled ? "1" : "0.4";
        endBtn.style.cursor  = s.btnEnabled ? "pointer" : "not-allowed";
        endBtn.title         = s.btnEnabled ? "" : "Waiting for call to connect...";
    }
}



//  FLOATING CALL HOVER BOARD

function start_call_hover(number) {

    // Inject styles once
    if (!document.getElementById("smartflo-styles")) {
        const style = document.createElement("style");
        style.id = "smartflo-styles";
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');

            @keyframes smartflo-pulse-yellow {
                0%   { box-shadow: 0 0 0 0 rgba(251,191,36,0.5); }
                70%  { box-shadow: 0 0 0 7px rgba(251,191,36,0); }
                100% { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
            }
            @keyframes smartflo-pulse-green {
                0%   { box-shadow: 0 0 0 0 rgba(52,211,153,0.5); }
                70%  { box-shadow: 0 0 0 7px rgba(52,211,153,0); }
                100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); }
            }
            @keyframes smartflo-pulse-blue {
                0%   { box-shadow: 0 0 0 0 rgba(96,165,250,0.5); }
                70%  { box-shadow: 0 0 0 7px rgba(96,165,250,0); }
                100% { box-shadow: 0 0 0 0 rgba(96,165,250,0); }
            }
            @keyframes smartflo-pulse-orange {
                0%   { box-shadow: 0 0 0 0 rgba(251,146,60,0.5); }
                70%  { box-shadow: 0 0 0 7px rgba(251,146,60,0); }
                100% { box-shadow: 0 0 0 0 rgba(251,146,60,0); }
            }
            @keyframes smartflo-slidein {
                from { opacity: 0; transform: translateY(16px) scale(0.97); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes smartflo-wave {
                0%, 60%, 100% { transform: scaleY(0.4); }
                30%            { transform: scaleY(1.0); }
            }
            #smartflo-hover {
                animation: smartflo-slidein 0.3s cubic-bezier(0.16,1,0.3,1) forwards;
            }
            #smartflo-end:not(:disabled):hover {
                background: linear-gradient(135deg, #ff6b6b, #ee3333) !important;
                transform: scale(1.04);
            }
            #smartflo-end:not(:disabled):active {
                transform: scale(0.97);
            }
            .smartflo-bar {
                display: inline-block;
                width: 3px;
                height: 14px;
                margin: 0 1.5px;
                border-radius: 2px;
                background: #34d399;
                transform-origin: bottom;
            }
            .smartflo-bar:nth-child(1) { animation: smartflo-wave 1.1s ease-in-out 0.0s infinite; }
            .smartflo-bar:nth-child(2) { animation: smartflo-wave 1.1s ease-in-out 0.15s infinite; }
            .smartflo-bar:nth-child(3) { animation: smartflo-wave 1.1s ease-in-out 0.3s infinite; }
            .smartflo-bar:nth-child(4) { animation: smartflo-wave 1.1s ease-in-out 0.45s infinite; }
        `;
        document.head.appendChild(style);
    }

    if (document.getElementById("smartflo-hover")) {
        document.getElementById("smartflo-hover").remove();
    }

    let startTime = Date.now();

    let board = document.createElement("div");
    board.id = "smartflo-hover";
    board.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        width: 240px;
        background: linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
        color: #e8eaf6;
        padding: 16px;
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.06) inset;
        border: 1px solid rgba(255,255,255,0.08);
        z-index: 9999;
        cursor: move;
        font-family: 'DM Sans', sans-serif;
        user-select: none;
    `;

    board.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:7px;">
                <span id="smartflo-dot" style="
                    display:inline-block;width:8px;height:8px;border-radius:50%;
                    background:#fbbf24;animation:smartflo-pulse-yellow 1.5s infinite;
                    flex-shrink:0;
                "></span>
                <span id="smartflo-status" style="
                    font-size:11px;font-weight:600;letter-spacing:0.5px;
                    padding:2px 8px;border-radius:20px;
                    background:rgba(251,191,36,0.15);color:#fbbf24;
                    border:1px solid rgba(251,191,36,0.3);
                ">Ringing...</span>
            </div>
            <div style="display:flex;align-items:flex-end;gap:0;height:14px;">
                <span class="smartflo-bar"></span>
                <span class="smartflo-bar"></span>
                <span class="smartflo-bar"></span>
                <span class="smartflo-bar"></span>
            </div>
        </div>

        <div style="height:1px;background:rgba(255,255,255,0.07);margin-bottom:12px;"></div>

        <div style="font-size:11px;color:rgba(255,255,255,0.4);font-weight:500;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:3px;">Number</div>
        <div style="font-size:17px;font-weight:600;letter-spacing:0.5px;color:#e8eaf6;margin-bottom:12px;">${number}</div>

        <div style="
            background:rgba(0,0,0,0.25);border-radius:10px;padding:8px 12px;
            display:flex;align-items:center;justify-content:space-between;
            margin-bottom:14px;border:1px solid rgba(255,255,255,0.05);
        ">
            <span style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:500;letter-spacing:0.5px;text-transform:uppercase;">Duration</span>
            <span id="smartflo-timer" style="font-family:'DM Mono',monospace;font-size:20px;font-weight:500;color:#e8eaf6;letter-spacing:1px;">00:00</span>
        </div>

        <button id="smartflo-end" disabled style="
            width:100%;
            background: linear-gradient(135deg, #ff4d4f, #cc2a2c);
            border: none;
            color: #fff;
            padding: 9px 0;
            border-radius: 10px;
            cursor: not-allowed;
            font-family: 'DM Sans', sans-serif;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.4px;
            transition: all 0.15s ease;
            box-shadow: 0 4px 12px rgba(255,77,79,0.35);
            opacity: 0.4;
        " title="Waiting for call to connect...">⏹ End Call</button>
    `;

    document.body.appendChild(board);

    // DRAG 
    let offsetX, offsetY, dragging = false;
    board.onmousedown = e => {
        if (e.target.id === "smartflo-end") return;
        dragging = true;
        offsetX = e.clientX - board.offsetLeft;
        offsetY = e.clientY - board.offsetTop;
    };
    document.onmousemove = e => {
        if (dragging) {
            board.style.left   = (e.clientX - offsetX) + "px";
            board.style.top    = (e.clientY - offsetY) + "px";
            board.style.right  = "auto";
            board.style.bottom = "auto";
        }
    };
    document.onmouseup = () => dragging = false;

    // TIMER 
    let timerInterval = setInterval(() => {
        let diff = Math.floor((Date.now() - startTime) / 1000);
        let m = String(Math.floor(diff / 60)).padStart(2, "0");
        let s = String(diff % 60).padStart(2, "0");
        let el = document.getElementById("smartflo-timer");
        if (el) el.innerText = `${m}:${s}`;
        else clearInterval(timerInterval);
    }, 1000);

    // END BUTTON → Case 3: RM clicks End in CRM
    document.getElementById("smartflo-end").onclick = async () => {
        if (!SMARTFLO_ACTIVE_CALL_ID) return;

        const callId = SMARTFLO_ACTIVE_CALL_ID;

        // Stop background poller and timer before API calls
        SMARTFLO_CALL_ALIVE = false;
        smartflo_stop_live_poll();
        clearInterval(timerInterval);
        smartflo_close_board();

        try {
            frappe.show_alert({ message: "Ending call...", indicator: "orange" });

            await frappe.call({
                method: `${SF_MODULE}.smartflo_hangup_call`,
                args: { call_id: callId }
            });

            frappe.show_alert({ message: "Fetching call record...", indicator: "blue" });

            await smartflo_save_record(callId);

        } catch (err) {
            console.error(err);
            frappe.msgprint("Error while ending call.");
        }
    };
}
