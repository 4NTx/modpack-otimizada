// AutoLogin — envia o login quando o servidor pedir a senha após um relog.
// Não publique este arquivo: ele contém a senha do servidor.

function parseAutoLoginYaml(text) {
    var config = {};
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        var match = line.match(/^\s*([^:#][^:]*):\s*(.*)$/);
        if (match === null) continue;
        var key = match[1].replace(/^\s+|\s+$/g, "");
        var raw = match[2].replace(/^\s+|\s+$/g, "");
        if (raw === "true") config[key] = true;
        else if (raw === "false") config[key] = false;
        else if (/^-?\d+$/.test(raw)) config[key] = Number(raw);
        else config[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return config;
}

var AUTOLOGIN_CONFIG = {};
try {
    AUTOLOGIN_CONFIG = parseAutoLoginYaml(FileLib.read("auto_login", "config.yml") || "");
} catch (error) { }

var LOGIN_COMMAND = AUTOLOGIN_CONFIG.loginCommand || "/login 190anti";
var LOGIN_DELAY_TICKS = AUTOLOGIN_CONFIG.delayTicks === undefined ? 10 : AUTOLOGIN_CONFIG.delayTicks;
var LOGIN_COOLDOWN_TICKS = AUTOLOGIN_CONFIG.cooldownTicks === undefined ? 200 : AUTOLOGIN_CONFIG.cooldownTicks;
var LOGIN_TRIGGER_TEXT = String(AUTOLOGIN_CONFIG.triggerText || "bem vindo de volta").toLowerCase();
var loginDelayTicks = 0;
var loginCooldownTicks = 0;
var autoLoginEnabled = AUTOLOGIN_CONFIG.enabled !== false;

function logAutoLogin(kind, message) {
    try {
        var file = kind === "ERRO" ? "data/error-log.txt" : "data/diagnostic-log.txt";
        var old = FileLib.read("auto_login", file) || "";
        if (old.length > 30000) old = old.substring(old.length - 22000);
        // Nunca inclua LOGIN_COMMAND aqui: ele contém a senha.
        FileLib.write("auto_login", file, "[" + new Date().toLocaleTimeString() + "] [" + kind + "] " + message + "\n" + old);
    } catch (ignored) { }
}

function prefix(message) {
    ChatLib.chat("&b[AutoLogin] " + message);
}

function showHelp() {
    prefix("&eComandos");
    ChatLib.chat("&e/autologin&7 ou &e/autologin status&7: mostra o estado atual.");
    ChatLib.chat("&e/autologin on&7: ativa nesta sessão.");
    ChatLib.chat("&e/autologin off&7: desativa nesta sessão e cancela o envio pendente.");
    ChatLib.chat("&e/autologin help&7: mostra esta ajuda.");
    ChatLib.chat("&7Configuração permanente: &fauto_login/config.yml&7 + &f/ct reload&7.");
}

register("chat", function (message) {
    if (!autoLoginEnabled || loginDelayTicks > 0 || loginCooldownTicks > 0) return;

    // Alguns servidores mandam a linha com §, outros sem cores. Aceita ambos.
    var visibleMessage = String(message).replace(/§[0-9A-FK-OR]/gi, "").replace(/&[0-9A-FK-OR]/gi, "");
    if (visibleMessage.toLowerCase().indexOf(LOGIN_TRIGGER_TEXT) === -1) return;
    if (visibleMessage.toLowerCase().indexOf("/login") === -1) return;

    loginDelayTicks = LOGIN_DELAY_TICKS;
    logAutoLogin("INFO", "pedido de login detectado; envio agendado em " + LOGIN_DELAY_TICKS + " ticks.");
    prefix("&eMensagem de login detectada; enviando em " + LOGIN_DELAY_TICKS + " ticks.");
}).setCriteria("${message}");

register("tick", function () {
    if (loginCooldownTicks > 0) loginCooldownTicks--;
    if (loginDelayTicks <= 0) return;

    loginDelayTicks--;
    if (loginDelayTicks === 0) {
        try {
            Client.getMinecraft().field_71439_g.func_71165_d(LOGIN_COMMAND);
            loginCooldownTicks = Math.max(20, parseInt(LOGIN_COOLDOWN_TICKS) || 200);
            logAutoLogin("INFO", "comando de login enviado; cooldown de " + loginCooldownTicks + " ticks.");
            prefix("&aComando /login enviado.");
        } catch (error) {
            logAutoLogin("ERRO", "falha ao enviar login: " + error);
            prefix("&cNão consegui enviar o login: " + error);
        }
    }
});

register("command", function (action) {
    var option = action === undefined ? "status" : String(action).toLowerCase();

    if (option === "on" || option === "ligar" || option === "start" || option === "iniciar") {
        autoLoginEnabled = true;
        logAutoLogin("INFO", "ativado por comando.");
        prefix("&aAtivado nesta sessão.");
        return;
    }
    if (option === "off" || option === "desligar" || option === "stop" || option === "parar") {
        autoLoginEnabled = false;
        loginDelayTicks = 0;
        loginCooldownTicks = 0;
        logAutoLogin("INFO", "desativado por comando.");
        prefix("&cDesativado nesta sessão.");
        return;
    }
    if (option === "help" || option === "ajuda") {
        showHelp();
        return;
    }
    if (option === "status" || option === "") {
        prefix("Estado: " + (autoLoginEnabled ? "&aATIVADO" : "&cDESATIVADO") + "&7 | atraso: &f" + LOGIN_DELAY_TICKS + " ticks &7| cooldown: &f" + loginCooldownTicks + " ticks");
        return;
    }
    prefix("&eComando desconhecido. Use &f/autologin help&e.");
}).setName("autologin");
