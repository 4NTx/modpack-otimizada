// BolsoCiclo - coordenador dos perfis BolsoFarm/BolsoArcos (MC 1.8.9)
ChatLib.chat("&a[BolsoCiclo] Módulo carregado. Use &fF&a ou &f/bolsociclo start&a para iniciar o fluxo completo.");
function yaml(text) {
    var root = {}, parents = [root], lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^(\s*)([^:#][^:]*):\s*(.*)$/);
        if (!m || /^\s*#/.test(lines[i])) continue;
        var depth = Math.floor(m[1].length / 2), key = m[2].replace(/^\s+|\s+$/g, ""), raw = m[3].replace(/^\s+|\s+$/g, "");
        while (parents.length > depth + 1) parents.pop();
        var parent = parents[depth] || root;
        if (raw === "") { parent[key] = {}; parents[depth + 1] = parent[key]; }
        else if (raw === "true") parent[key] = true;
        else if (raw === "false") parent[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(raw)) parent[key] = Number(raw);
        else parent[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return root;
}
var cfg = {};
try { cfg = yaml(FileLib.read("BolsoCiclo", "config.yml") || ""); } catch (e) { ChatLib.chat("&c[BolsoCiclo] Não foi possível ler config.yml."); }
function value(path, fallback) { try { var obj = cfg; for (var i = 0; i < path.length; i++) obj = obj[path[i]]; return obj === undefined ? fallback : obj; } catch (e) { return fallback; } }
var skeletonTicks = Math.max(1, Number(value(["phases", "skeleton", "hours"], 3))) * 72000;
var spiderTicks = Math.max(1, Number(value(["phases", "spider", "hours"], 3))) * 72000;
var repairTicks = Math.max(1, Number(value(["phases", "repair", "hours"], 3))) * 72000;
var startDelay = Math.max(20, parseInt(value(["timing", "startDelayTicks"], 50)) || 50);
var AUTO_RESUME_AFTER_RELOG = value(["behavior", "resumeAfterRelog"], true) === true;
var Keyboard = Java.type("org.lwjgl.input.Keyboard");
var cycleKeybind = new KeyBind("BolsoCiclo", Keyboard.KEY_F);
function log(kind, message) {
    try {
        var old = FileLib.read("BolsoCiclo", "data/cycle-log.txt") || "";
        old += "[" + new Date().toLocaleTimeString() + "] [" + kind + "] " + message + "\n";
        if (old.length > 60000) old = old.substring(old.length - 45000);
        FileLib.write("BolsoCiclo", "data/cycle-log.txt", old);
    } catch (ignoredLog) { }
}
// Um ciclo iniciado manualmente sempre começa reparando. A fase salva só vale durante uma retomada ativa.
var run = false, phase = "repair", elapsed = 0, pendingStart = 0, switchTicks = 0, forceStopTicks = 0, phaseBeingStopped = null;
try {
    var saved = JSON.parse(FileLib.read("BolsoCiclo", "data/runtime.json") || "{}");
    run = saved.run === true; phase = saved.phase || phase; elapsed = Math.max(0, parseInt(saved.elapsed) || 0); pendingStart = saved.pendingStart === true ? startDelay : 0; switchTicks = saved.pendingSwitch === true ? 20 : 0;
} catch (e) { }
// Um /ct reload descarrega as macros que estavam em execução. Se o ciclo foi
// salvo ativo e não havia uma troca pendente, agenda novamente a fase salva.
if (run && pendingStart === 0 && switchTicks === 0) pendingStart = startDelay;
function save() { try { FileLib.write("BolsoCiclo", "data/runtime.json", JSON.stringify({ run: run, phase: phase, elapsed: elapsed, pendingStart: pendingStart > 0, pendingSwitch: switchTicks > 0 })); } catch (e) { } }
function normalizePhase(name) {
    name = String(name || "").toLowerCase().replace(/ç/g, "c").replace(/ã/g, "a").replace(/á/g, "a").trim();
    if (name === "esqueleto" || name === "skeleton") return "skeleton";
    if (name === "aranha" || name === "spider") return "spider";
    if (name === "reparar" || name === "reparacao" || name === "repair" || name === "arcos") return "repair";
    return null;
}
function phaseName() { return phase === "skeleton" ? "esqueleto" : (phase === "spider" ? "aranha" : "reparação de arcos"); }
function limit() { return phase === "skeleton" ? skeletonTicks : (phase === "spider" ? spiderTicks : repairTicks); }
function remainingMinutes() { return Math.max(0, Math.ceil((limit() - elapsed) / 1200)); }
function showHelp() {
    ChatLib.chat("&6&m---------------- &eBolsoCiclo &6&m----------------");
    ChatLib.chat("&e/bolsociclo start [esqueleto|aranha|reparar]&7: inicia o ciclo na fase desejada.");
    ChatLib.chat("&e/bolsociclo stop&7: para somente o coordenador.");
    ChatLib.chat("&e/bolsociclo status&7: mostra fase, tempo restante e retomada.");
    ChatLib.chat("&e/bolsociclo help&7: mostra esta ajuda.");
    ChatLib.chat("&7Fluxo: &fesqueleto → aranha → BolsoArcos → esqueleto.");
    ChatLib.chat("&7As fases trocam por tempo ou após esgotar/falhar depois das proteções.");
    ChatLib.chat("&6&m------------------------------------------------");
}
cycleKeybind.registerKeyPress(function () {
    ChatLib.command(run ? "bolsociclo stop" : "bolsociclo start", true);
});
function beginCurrentPhase() {
    pendingStart = startDelay;
    save();
    if (phase === "repair") {
        log("FASE", "reparação; início agendado");
        ChatLib.chat("&b[BolsoCiclo] Fase: &fBolsoArcos&7. Inicia em instantes.");
        return;
    }
    var profile = phase === "skeleton" ? String(value(["phases", "skeleton", "profile"], "esqueleto")) : String(value(["phases", "spider", "profile"], "aranha"));
    log("FASE", phaseName() + "; perfil=" + profile + "; início agendado");
    ChatLib.chat("&b[BolsoCiclo] Fase: &f" + phaseName() + "&7. Aplicando perfil " + profile + ".");
    ChatLib.command("bolsofarm perfil " + profile, true);
}
function stopMacroForPhase(which) {
    try { ChatLib.command(which === "repair" ? "bolsoarcos stop" : "bolsofarm stop", true); } catch (ignoredStop) { }
}
function next(reason) {
    if (!run) return;
    phaseBeingStopped = phase;
    elapsed = 0;
    phase = phase === "skeleton" ? "spider" : (phase === "spider" ? "repair" : "skeleton");
    ChatLib.chat("&a[BolsoCiclo] Próxima fase: &f" + phaseName() + " &7(" + reason + ").");
    log("TROCA", "para " + phase + "; motivo=" + reason);
    // Confirma a parada com mais de um comando antes de iniciar outra macro.
    // Evita que uma GUI, tecla ou teleporte da fase anterior sobreviva à troca.
    switchTicks = 40;
    save();
}
register("tick", function () {
    // ChatTriggers enfileira comandos: repete a parada curta para vencer comandos
    // pendentes de início/troca e garantir que as duas macros soltem teclas/telas.
    if (forceStopTicks > 0) {
        forceStopTicks--;
        if (forceStopTicks === 39 || forceStopTicks === 20 || forceStopTicks === 1) {
            try { FileLib.write("BolsoFarm", "data/runtime.json", JSON.stringify({ enabled: false })); } catch (ignoredFarmRuntime) { }
            try { ChatLib.command("bolsofarm stop", true); } catch (ignoredFarmStop) { }
            try { ChatLib.command("bolsoarcos stop", true); } catch (ignoredArcosStop) { }
        }
    }
    if (!run) return;
    // Não conta tempo no menu/desconectado. Assim um restart longo do servidor
    // não consome a fase nem tenta mandar comandos sem mundo/jogador.
    try {
        var minecraft = Client.getMinecraft();
        if (minecraft.field_71441_e === null || minecraft.field_71439_g === null) return;
    } catch (ignoredWorld) { return; }
    if (switchTicks > 0) {
        if (switchTicks === 40 || switchTicks === 20 || switchTicks === 1) stopMacroForPhase(phaseBeingStopped);
        switchTicks--;
        if (switchTicks === 0) { phaseBeingStopped = null; beginCurrentPhase(); }
        return;
    }
    if (pendingStart > 0) {
        pendingStart--;
        if (pendingStart === 0) {
            save();
            log("INÍCIO", "macro=" + (phase === "repair" ? "BolsoArcos" : "BolsoFarm") + "; fase=" + phase);
            ChatLib.command(phase === "repair" ? "bolsoarcos start" : "bolsofarm start", true);
        }
        return;
    }
    elapsed++;
    if (elapsed % 1200 === 0) save();
    if (elapsed >= limit()) {
        next("tempo configurado atingido");
    }
});
register("command", function (action, target) {
    var opt = String(action || "status").toLowerCase();
    if (opt === "help" || opt === "ajuda") { showHelp(); return; }
    if (opt === "start" || opt === "iniciar") {
        if (run) { ChatLib.chat("&e[BolsoCiclo] Já está em execução: " + phaseName() + "."); return; }
        // Sem argumento, retoma a última fase salva; na primeira instalação a
        // runtime já aponta para reparação, conforme a configuração inicial.
        run = true; phase = normalizePhase(target || "repair") || "repair"; elapsed = 0;
        log("COMANDO", "ciclo iniciado na fase " + phase);
        beginCurrentPhase(); return;
    }
    if (opt === "stop" || opt === "parar") {
        // Desligamento total: primeiro remove a autoridade do ciclo, depois
        // para as duas macros e apaga a retomada persistida do BolsoFarm.
        run = false;
        pendingStart = 0;
        switchTicks = 0;
        forceStopTicks = 40;
        save();
        try { FileLib.write("BolsoFarm", "data/runtime.json", JSON.stringify({ enabled: false })); } catch (ignoredFarmRuntime) { }
        try { ChatLib.command("bolsofarm stop", true); } catch (ignoredFarmStop) { }
        try { ChatLib.command("bolsoarcos stop", true); } catch (ignoredArcosStop) { }
        log("COMANDO", "ciclo e macros desligados manualmente");
        ChatLib.chat("&c[BolsoCiclo] Tudo desligado: ciclo, BolsoFarm e BolsoArcos. Não retomará no relog.");
        return;
    }
    if (opt === "complete") {
        var kind = String(target || "").toLowerCase();
        if (!run || (kind === "farm" && phase === "repair") || (kind === "repair" && phase !== "repair")) return;
        next(kind === "repair" ? "BolsoArcos concluiu todos os arcos" : "parede de espada/material esgotada"); return;
    }
    ChatLib.chat("&b[BolsoCiclo] " + (run ? "ATIVO" : "PARADO") + "&7 | fase: &f" + phaseName() + "&7 | decorridos: &f" + Math.floor(elapsed / 1200) + " min &7| restantes: &f" + remainingMinutes() + " min");
    ChatLib.chat("&7Retomada após relog: " + (AUTO_RESUME_AFTER_RELOG ? "&aATIVADA" : "&cDESATIVADA") + "&7 | log: &fBolsoCiclo/data/cycle-log.txt");
}).setName("bolsociclo");

// Após reinício do servidor/reconexão, o runtime salvo preserva a fase. Dá
// tempo para login/AutoLogin terminar e religa somente a macro correspondente.
register("worldLoad", function () {
    if (!AUTO_RESUME_AFTER_RELOG || !run) return;
    // /home e warps do servidor também disparam worldLoad. O estado das macros
    // permanece na memória e seus próprios watchdogs retomam o passo seguro;
    // iniciar novamente aqui causava várias execuções concorrentes.
    log("MUNDO", "mudança de mundo detectada; preservando a fase " + phase + " sem reiniciar a macro.");
});
