let SMARTFLO_ACTIVE_CALL_ID = null;

frappe.ui.form.on("Smartflo Settings", {
    refresh(frm) {

        frm.add_custom_button("Click To Call", () => {

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

                primary_action(values) {

                    frappe.call({
                        method: "smartflo_integration.api.smartflo_click_to_call",
                        args: values,
                        freeze: true,
                        freeze_message: "Calling...",
                        callback: (r) => {

                            if (r.exc) return;

                            dialog.hide();

                            start_call_hover(values.destination_number);

                            frappe.show_alert({
                                message: "Call initiated",
                                indicator: "green"
                            });

                            // ⏳ Wait until call becomes active
                            setTimeout(() => {

                                frappe.call({
                                    method: "smartflo_integration.api.smartflo_sync_live_calls",
                                    callback: (sync_r) => {

                                        if (!sync_r.exc && sync_r.message?.latest_call_id) {
                                            SMARTFLO_ACTIVE_CALL_ID = sync_r.message.latest_call_id;

                                            frappe.show_alert({
                                                message: "Call connected",
                                                indicator: "blue"
                                            });
                                        }
                                    }
                                });

                            }, 20000);
                        }
                    });

                }
            });

            dialog.show();

        }).addClass("btn-success");
    }
});


// --------------------------------------------------
// FLOATING CALL HOVER BOARD
// --------------------------------------------------
function start_call_hover(number) {

    // remove existing
    if (document.getElementById("smartflo-hover")) {
        document.getElementById("smartflo-hover").remove();
    }

    let startTime = Date.now();

    let board = document.createElement("div");
    board.id = "smartflo-hover";
    board.style = `
        position:fixed;
        bottom:30px;
        right:30px;
        width:220px;
        background:#111;
        color:#fff;
        padding:12px;
        border-radius:10px;
        box-shadow:0 4px 12px rgba(0,0,0,.3);
        z-index:9999;
        cursor:move;
        font-family:Arial;
    `;

    board.innerHTML = `
        <div style="font-size:13px;opacity:.7">On Call</div>
        <div style="font-size:16px;margin-top:4px">${number}</div>
        <div id="smartflo-timer" style="font-size:22px;margin-top:6px">00:00</div>
        <div style="margin-top:8px;text-align:right">
            <button id="smartflo-end"
                style="background:#ff4d4f;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;">
                End
            </button>
        </div>
    `;

    document.body.appendChild(board);

    // ---------------- DRAG ----------------
    let offsetX, offsetY, dragging=false;

    board.onmousedown = e=>{
        dragging=true;
        offsetX=e.clientX-board.offsetLeft;
        offsetY=e.clientY-board.offsetTop;
    };

    document.onmousemove=e=>{
        if(dragging){
            board.style.left=(e.clientX-offsetX)+"px";
            board.style.top=(e.clientY-offsetY)+"px";
            board.style.right="auto";
            board.style.bottom="auto";
        }
    };

    document.onmouseup=()=>dragging=false;

    // ---------------- TIMER ----------------
    let timer=setInterval(()=>{
        let diff=Math.floor((Date.now()-startTime)/1000);
        let m=String(Math.floor(diff/60)).padStart(2,"0");
        let s=String(diff%60).padStart(2,"0");
        let el=document.getElementById("smartflo-timer");
        if (el) el.innerText=`${m}:${s}`;
    },1000);

    // ---------------- END BUTTON ----------------
    document.getElementById("smartflo-end").onclick = () => {

        if (!SMARTFLO_ACTIVE_CALL_ID) {
            frappe.show_alert({
                message: "Call ID not ready",
                indicator: "red"
            });
            return;
        }

        const callId = SMARTFLO_ACTIVE_CALL_ID;
        SMARTFLO_ACTIVE_CALL_ID = null;

        // 🟢 CLOSE UI IMMEDIATELY
        clearInterval(timer);
        board.remove();

        frappe.show_alert({
            message: "Ending call...",
            indicator: "orange"
        });

        // 1️⃣ Hangup immediately
        frappe.call({
            method: "smartflo_integration.api.smartflo_hangup_call",
            args: { call_id: callId }
        });

        // 2️⃣ After 15s → fetch call record
        setTimeout(() => {

            frappe.show_alert({
                message: "Fetching call record...",
                indicator: "blue"
            });

            frappe.call({
                method: "smartflo_integration.api.smartflo_sync_call_record",
                args: { call_id: callId },
                callback: () => {
                    frappe.show_alert({
                        message: "Call record saved",
                        indicator: "green"
                    });
                }
            });

        }, 25000); // ← your required 15 seconds
    };
}