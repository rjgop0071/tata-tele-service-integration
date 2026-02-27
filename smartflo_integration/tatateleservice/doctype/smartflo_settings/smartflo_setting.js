frappe.ui.form.on("Smartflo Settings", {
    refresh: function(frm) {
        frm.add_custom_button("Login to Smartflo", function() {

            frappe.call({
                method: "smartflo_integration.api.smartflo_login",
                freeze: true,
                freeze_message: "Logging in to Smartflo...",
                callback: function(r) {
                    if (r.message && r.message.status === "success") {
                        frappe.msgprint({
                            title: "Success",
                            message: "Smartflo login successful!",
                            indicator: "green"
                        });
                        frm.reload_doc();
                    }
                }
            });

        }).addClass("btn-primary");
    }
});
