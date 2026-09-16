// AutoReparar v2 - ChatTriggers 2.2.0 / Minecraft 1.8.9 / Java 8
// Contrato do baú: o /home baus deve nascer olhando diretamente para um baú comum.
// A macro nunca guarda espadas, machados ou a primeira pilha do material da ferramenta em reparo.

ChatLib.chat("&a[BolsoFarm] Módulo carregado. Use &f/bolsofarm start&a ou deixe o &fBolsoCiclo&a controlar o fluxo.");

// ============================================================================
// DIAGNÓSTICO E TELEMETRIA
// ============================================================================
// Diagnóstico visível: o módulo nunca deve esconder uma exceção que impeça a
// macro de agir. Repetições iguais em menos de 2 s são agrupadas para evitar
// vinte mensagens por segundo quando um evento `tick` falha.
var lastReportedError = "";
var lastReportedErrorAt = 0;
var ERROR_LOG_FILE = "data/error-log.txt";
var TRACE_LOG_FILE = "data/diagnostic-log.txt";
var traceLastState = null;
var traceTicks = 0;

function appendDiagnostic(kind, message) {
    try {
        var previous = FileLib.read("BolsoFarm", TRACE_LOG_FILE) || "";
        var stateName = typeof state === "undefined" ? "carregando" : state;
        var entry = "[" + new Date().toLocaleTimeString() + "] [" + kind + "] [" + stateName + "] " + message + "\n";
        if (previous.length > 100000) previous = previous.substring(previous.length - 75000);
        FileLib.write("BolsoFarm", TRACE_LOG_FILE, previous + entry);
    } catch (ignored) { }
}

function reportError(where, error) {
    try {
        var detail = String(error === undefined || error === null ? "erro desconhecido" : error)
            .replace(/[\r\n]+/g, " ");
        if (detail.length > 180) detail = detail.substring(0, 180) + "...";
        var currentState = typeof state === "undefined" ? "carregando" : state;
        var key = where + ":" + detail;
        var now = new Date().getTime();
        if (key === lastReportedError && now - lastReportedErrorAt < 2000) return;
        lastReportedError = key;
        lastReportedErrorAt = now;
        appendDiagnostic("ERRO", where + ": " + detail);
        // Mantém o arquivo pequeno e legível, inclusive depois de relogar.
        try {
            var oldLog = FileLib.read("BolsoFarm", ERROR_LOG_FILE) || "";
            var entry = "[" + new Date().toLocaleTimeString() + "] [" + currentState + "] " + where + ": " + detail + "\n";
            if (oldLog.length > 60000) oldLog = oldLog.substring(oldLog.length - 45000);
            FileLib.write("BolsoFarm", ERROR_LOG_FILE, oldLog + entry);
        } catch (logError) { }
        ChatLib.chat("&4&l[BolsoFarm ERRO] &c" + where + " &7(estado: " + currentState + ")");
        ChatLib.chat("&c" + detail);
    } catch (ignored) { }
}

// Não depende de exceção: registra o caminho real seguido pela macro. É a
// evidência para diagnosticar casos como uma espada quebrada sem reposição.
register("tick", function () {
    try {
        if (typeof enabled === "undefined" || !enabled) return;
        traceTicks++;
        var stateChanged = traceLastState !== state;
        if (!stateChanged && traceTicks < 100) return; // a cada 5 segundos
        traceTicks = 0;
        traceLastState = state;
        var held = Player.getHeldItem();
        if (held === null) {
            appendDiagnostic(stateChanged ? "ESTADO" : "PULSO", "mão vazia; espera=" + waitTicks);
            return;
        }
        var maximum = held.getMaxDamage();
        var damage = held.getDamage();
        appendDiagnostic(stateChanged ? "ESTADO" : "PULSO",
            "mão=" + held.getRegistryName() + "; dano=" + damage + "/" + maximum + "; restante=" + (maximum - damage) + "; espera=" + waitTicks);
    } catch (error) { reportError("coletar diagnóstico de execução", error); }
});

// Prioridade de espaço: não tenta buscar espada/material com a mochila cheia.
// É independente do loop principal, que pode ficar aguardando após um warp.
var inventorySafetyTicks = 0;
register("tick", function () {
    if (!enabled || state !== "FARMING") {
        inventorySafetyTicks = 0;
        return;
    }
    inventorySafetyTicks++;
    if (inventorySafetyTicks < 20) return;
    inventorySafetyTicks = 0;
    try {
        if (prepareStorage() && pendingStorageSlots.length > 0) {
            appendDiagnostic("RECUPERAÇÃO", "inventário sem espaço; depósito priorizado antes da reposição.");
            beginStorage();
        }
    } catch (error) { reportError("verificar espaço antes de reposição", error); }
});

// ============================================================================
// CONFIGURAÇÃO E PERSISTÊNCIA
// ============================================================================
// Persiste apenas a intenção do jogador: ligado volta após relog; desligado não.
var autoResumeRequested = false;
var startupResumeQueued = false;
try {
    autoResumeRequested = JSON.parse(FileLib.read("BolsoFarm", "data/runtime.json") || "{}").enabled === true;
} catch (error) { reportError("carregar estado salvo", error); }

function saveRunState() {
    try {
        FileLib.write("BolsoFarm", "data/runtime.json", JSON.stringify({ enabled: enabled }));
    } catch (error) { reportError("salvar estado", error); }
}

// Quando o BolsoCiclo está ativo ele é a única autoridade que religa macros.
// Isso evita BolsoFarm e BolsoArcos começarem juntos após /ct reload/relogin.
function cycleControlsStartup() {
    try { return JSON.parse(FileLib.read("BolsoCiclo", "data/runtime.json") || "{}").run === true; }
    catch (ignoredCycleState) { return false; }
}

var HOME_FARM = "/home mob";
var HOME_REPAIR = "/home reparar";
var HOME_STORAGE = "/home baus";
var HOME_STORAGE_TEMPORARY = "/home bolsofarmdeposito";
// Margem acima do ponto crítico: evita que a ferramenta quebre durante o warp.
var LOW_DURABILITY = 30;
var MIN_FREE_SLOTS = 3;
var MIN_STORABLE_ITEMS = 23;
// Um baú duplo ocupa duas colunas. Agachado, ~30 ticks deslocam perto de 2 blocos.
// Baú normal + baú com armadilha alternados ocupam uma posição cada.
// Um passo curto evita pular o baú imediatamente à direita.
var CHEST_STEP_TICKS = 15;
var MAX_CHEST_COLUMNS = 128;
// A /home baus nasce alinhada ao baú do meio (linha 2).
// Linhas da parede: topo (0) até fundo (4), com o jogador olhando norte.
var CHEST_ROW_PITCH = [-53, -34, 0, 34, 53];
var CHEST_ROW_TARGETS = [null, null, null, null, null];
var repairAim = null;
var farmAim = null;

// Configuração editável: config.yml. Valores ausentes mantêm estes padrões.
function parseConfigYaml(text) {
    var root = {};
    var parents = [root];
    var lines = String(text || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
        var match = line.match(/^(\s*)([^:#][^:]*):\s*(.*)$/);
        if (match === null) continue;
        var depth = Math.floor(match[1].length / 2);
        var key = match[2].replace(/^\s+|\s+$/g, "");
        var raw = match[3].replace(/^\s+|\s+$/g, "");
        while (parents.length > depth + 1) parents.pop();
        var parent = parents[depth] || root;
        if (raw.length === 0) {
            parent[key] = {};
            parents[depth + 1] = parent[key];
            continue;
        }
        if (raw === "true") parent[key] = true;
        else if (raw === "false") parent[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(raw)) parent[key] = Number(raw);
        else parent[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return root;
}

var MACRO_CONFIG = {};
try {
    MACRO_CONFIG = parseConfigYaml(FileLib.read("BolsoFarm", "config.yml") || "");
} catch (error) {
    reportError("ler config.yml", error);
    ChatLib.chat("&c[BolsoFarm] config.yml inválido; usando os valores padrão.");
    MACRO_CONFIG = {};
}

// PERFIS: cada perfil pode sobrescrever qualquer seção do config.yml (homes,
// inventory, selling, discard...). A escolha fica salva e sobrevive ao /ct reload.
var ACTIVE_PROFILE_NAME = "esqueleto";
try {
    var savedProfile = JSON.parse(FileLib.read("BolsoFarm", "data/profile.json") || "{}");
    if (savedProfile.name !== undefined && String(savedProfile.name).trim() !== "") ACTIVE_PROFILE_NAME = String(savedProfile.name).toLowerCase().trim();
} catch (ignoredProfile) { }
var ACTIVE_PROFILE_CONFIG = {};
try {
    if (MACRO_CONFIG.profiles !== undefined && MACRO_CONFIG.profiles[ACTIVE_PROFILE_NAME] !== undefined) ACTIVE_PROFILE_CONFIG = MACRO_CONFIG.profiles[ACTIVE_PROFILE_NAME];
} catch (ignoredProfileConfig) { }

function calibrationFileForProfile(name) { return "data/calibration-" + String(name).toLowerCase().replace(/[^a-z0-9_-]/g, "") + ".json"; }
function profileCalibrationFile() { return calibrationFileForProfile(ACTIVE_PROFILE_NAME); }
function profileDataName() { return String(ACTIVE_PROFILE_NAME || "esqueleto").replace(/[^a-z0-9_-]/gi, "_"); }
function storageProgressFile() { return "data/storage-progress-" + profileDataName() + ".json"; }
function storageReturnFile() { return "data/storage-return-" + profileDataName() + ".json"; }
function farmAimFileForProfile(name) { return "data/farm-aim-" + String(name).toLowerCase().replace(/[^a-z0-9_-]/g, "") + ".json"; }

// Calibra qualquer perfil sem recarregar/trocar a macro ativa. A mira é salva
// diretamente no arquivo daquela parede MKB.
function calibrateNamedProfile(profileName, rowNumber) {
    try {
        profileName = String(profileName || "").toLowerCase().trim();
        if (MACRO_CONFIG.profiles === undefined || MACRO_CONFIG.profiles[profileName] === undefined) throw "perfil inexistente";
        if (enabled) throw "desligue a BolsoFarm antes de calibrar";
        rowNumber = parseInt(rowNumber);
        if (isNaN(rowNumber) || rowNumber < 1 || rowNumber > 5) throw "use uma linha de 1 a 5";
        var player = Client.getMinecraft().field_71439_g, hit = Client.getMinecraft().field_71476_x;
        if (player === null || hit === null || hit.func_178782_a() === null) throw "mire diretamente no baú";
        var saved = {};
        try { saved = JSON.parse(FileLib.read("BolsoFarm", calibrationFileForProfile(profileName)) || "{}"); } catch (ignoredRead) { }
        var pitches = saved.pitch !== undefined && saved.pitch.length === 5 ? saved.pitch : [-53, -34, 0, 34, 53];
        var targets = saved.targets !== undefined && saved.targets.length === 5 ? saved.targets : [null, null, null, null, null];
        var pos = hit.func_178782_a(), index = rowNumber - 1;
        pitches[index] = player.field_70125_A;
        targets[index] = { x: pos.func_177958_n(), y: pos.func_177956_o(), z: pos.func_177952_p(), side: "SOUTH" };
        FileLib.write("BolsoFarm", calibrationFileForProfile(profileName), JSON.stringify({ pitch: pitches, targets: targets }));
        ChatLib.chat("&a[BolsoFarm] Perfil &f" + profileName + "&a, linha " + rowNumber + " calibrada.");
    } catch (error) { ChatLib.chat("&c[BolsoFarm] Calibração não salva: " + error); }
}

function showProfileCalibrations() {
    var names = ["esqueleto", "aranha"];
    ChatLib.chat("&6&m------------- &eCalibrações BolsoFarm &6&m-------------");
    for (var i = 0; i < names.length; i++) {
        var saved = {}, count = 0;
        try { saved = JSON.parse(FileLib.read("BolsoFarm", calibrationFileForProfile(names[i])) || "{}"); } catch (ignoredRead) { }
        if (saved.targets !== undefined) for (var row = 0; row < 5; row++) if (saved.targets[row] !== null && saved.targets[row] !== undefined) count++;
        var status = count === 5 ? "&aCOMPLETA" : (count === 0 ? "&cNÃO CALIBRADA" : "&ePARCIAL");
        ChatLib.chat("&b[BolsoFarm] &f" + names[i] + "&7: " + status + " &7(" + count + "/5 linhas)");
        if (count < 5) ChatLib.chat("&7  Use: &e/bolsofarm calibrar " + names[i] + " <1-5>&7 mirando no baú.");
    }
    ChatLib.chat("&7A calibração é independente por perfil; não altera o perfil em uso.");
    ChatLib.chat("&6&m------------------------------------------------");
}

function saveNamedFarmAim(profileName) {
    try {
        profileName = String(profileName || "").toLowerCase().trim();
        if (MACRO_CONFIG.profiles === undefined || MACRO_CONFIG.profiles[profileName] === undefined) throw "perfil inexistente";
        if (enabled) throw "desligue a BolsoFarm antes de salvar";
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) throw "jogador indisponível";
        var aim = { yaw: player.field_70177_z, pitch: player.field_70125_A, target: { x: player.field_70165_t, y: player.field_70163_u, z: player.field_70161_v } };
        FileLib.write("BolsoFarm", farmAimFileForProfile(profileName), JSON.stringify(aim));
        ChatLib.chat("&a[BolsoFarm] Ponto da mobtrap &f" + profileName + "&a salvo separadamente.");
    } catch (error) { ChatLib.chat("&c[BolsoFarm] Ponto não salvo: " + error); }
}

function configValue(section, key, fallback) {
    try {
        if (ACTIVE_PROFILE_CONFIG[section] !== undefined && ACTIVE_PROFILE_CONFIG[section][key] !== undefined) {
            return ACTIVE_PROFILE_CONFIG[section][key];
        }
        if (MACRO_CONFIG[section] !== undefined && MACRO_CONFIG[section][key] !== undefined) {
            return MACRO_CONFIG[section][key];
        }
    } catch (error) { reportError("ler config " + section + "." + key, error); }
    return fallback;
}

function setHomeCommandFromHomeCommand(homeCommand) {
    // Converte, por exemplo, "/home minha_farm" em "/sethome minha_farm".
    // Se for um comando fora desse formato, não arrisca executar outro comando.
    var match = String(homeCommand).match(/^\s*\/home\s+(.+?)\s*$/i);
    return match === null ? null : "/sethome " + match[1];
}

HOME_FARM = configValue("homes", "farm", HOME_FARM);
HOME_REPAIR = configValue("homes", "repair", HOME_REPAIR);
HOME_STORAGE = configValue("homes", "storage", HOME_STORAGE);
HOME_STORAGE_TEMPORARY = configValue("homes", "temporaryStorage", HOME_STORAGE_TEMPORARY);
LOW_DURABILITY = configValue("repair", "lowDurability", LOW_DURABILITY);
var configuredReserveDurability = parseInt(configValue("repair", "minReserveDurability", LOW_DURABILITY + 1));
var MIN_RESERVE_DURABILITY = isNaN(configuredReserveDurability) ? LOW_DURABILITY + 1 : Math.max(1, configuredReserveDurability);
var SAME_TOOL_TYPE_ONLY = configValue("repair", "sameToolTypeOnly", false);
var FALLBACK_TO_START_TOOL_ON_MISSING_MATERIAL = configValue("repair", "fallbackToStartToolOnMissingMaterial", true);
MIN_FREE_SLOTS = configValue("inventory", "minFreeSlots", MIN_FREE_SLOTS);
MIN_STORABLE_ITEMS = configValue("inventory", "minStorableStacks", MIN_STORABLE_ITEMS);
var DEPOSIT_HOTBAR = configValue("inventory", "depositHotbar", true);
var STORAGE_ONLY_ITEMS = String(configValue("inventory", "storageOnlyItems", "minecraft:bow")).split(",").map(function (itemId) {
    return itemId.replace(/^\s+|\s+$/g, "");
}).filter(function (itemId) { return itemId !== ""; });
CHEST_STEP_TICKS = configValue("chests", "stepTicks", CHEST_STEP_TICKS);
MAX_CHEST_COLUMNS = configValue("chests", "maxColumns", MAX_CHEST_COLUMNS);
var RESET_STORAGE_PROGRESS_AFTER_FULL_SEARCH = configValue("chests", "resetStorageProgressAfterFullSearch", true) !== false;
var REPLACEMENT_SEARCH_MAX_COLUMNS = Math.max(1, parseInt(configValue("chests", "replacementSearchMaxColumns", 5)) || 5);
var REPLACEMENT_SEARCH_ALL_ROWS = configValue("chests", "replacementSearchAllRows", true) === true;
// Limite separado para material: ao esgotá-lo, repair_then_replace troca a
// ferramenta em vez de caminhar indefinidamente pela parede de baús.
var MATERIAL_SEARCH_MAX_COLUMNS = Math.max(1, parseInt(configValue("chests", "materialSearchMaxColumns", 10)) || 10);
// first_column evita que a busca de material caminhe pela parede inteira.
// wall mantém o comportamento antigo para quem espalha materiais por colunas.
var MATERIAL_SEARCH_MODE = String(configValue("chests", "materialSearch", "first_column")).toLowerCase();
var USE_SAVED_CHEST_CALIBRATION = configValue("chests", "useSavedCalibration", false);
var REMEMBER_LAST_STORAGE_CHEST = configValue("storage", "rememberLastChest", true);
var USE_TEMPORARY_STORAGE_HOME = configValue("storage", "useTemporaryHome", false) === true || String(configValue("storage", "useTemporaryHome", false)).toLowerCase() === "true";
var TEMPORARY_STORAGE_HOME_CONFIRM_TICKS = Math.max(20, parseInt(configValue("storage", "temporaryHomeConfirmTicks", 40)) || 40);
// Zero confirma no próximo tick: rápido, mas ainda valida cada pilha antes de
// continuar. A confirmação impede perder itens quando um baú está cheio.
var STORAGE_TRANSFER_DELAY_TICKS = Math.max(0, parseInt(configValue("storage", "transferDelayTicks", 0)) || 0);
var SELLING_ENABLED = configValue("selling", "enabled", false) === true || String(configValue("selling", "enabled", false)).toLowerCase() === "true";
var SELLING_ONLY_PERIODIC = configValue("selling", "onlyPeriodic", false) === true || String(configValue("selling", "onlyPeriodic", false)).toLowerCase() === "true";
var SELLING_WHEN_STORING = configValue("selling", "sellWhenStoring", true) === true || String(configValue("selling", "sellWhenStoring", true)).toLowerCase() === "true";
var SELLING_WARP_WAIT_TICKS = Math.max(20, parseInt(configValue("selling", "warpWaitTicks", 55)) || 55);
var SELLING_SIGN_ATTACKS = Math.max(1, parseInt(configValue("selling", "signAttacksPerStack", 1)) || 1);
var SELLING_SIGN_HOLD_TICKS = Math.max(1, parseInt(configValue("selling", "signAttackHoldTicks", 8)) || 8);
// Zero desliga a viagem periódica: a venda ocorrerá apenas quando já for
// necessário ir ao depósito (sellWhenStoring).
var SELLING_PERIODIC_CHECK_MINUTES = Math.max(0, parseInt(configValue("selling", "periodicCheckMinutes", 0)) || 0);
var SELLING_PERIODIC_ENABLED = SELLING_PERIODIC_CHECK_MINUTES > 0;
var SELLING_PERIODIC_CHECK_TICKS = SELLING_PERIODIC_ENABLED ? SELLING_PERIODIC_CHECK_MINUTES * 1200 : 0;
var SELLING_RESULT_WAIT_TICKS = Math.max(2, parseInt(configValue("selling", "resultWaitTicks", 12)) || 12);
var SELLING_HIDE_COMMAND = String(configValue("selling", "hideCommand", "/esconder"));
var SELLING_MENU_OFF_COMMAND = String(configValue("selling", "menuOffCommand", "/menuloja off"));
var SELLING_MAX_NO_PROGRESS = Math.max(1, parseInt(configValue("selling", "maxNoProgressChecks", 2)) || 2);
var SELLING_MIN_ITEMS_WHEN_STORING = Math.max(1, parseInt(configValue("selling", "minimumItemsWhenStoring", 32)) || 32);
var SELLING_ITEMS = ACTIVE_PROFILE_CONFIG.selling && ACTIVE_PROFILE_CONFIG.selling.sales ? ACTIVE_PROFILE_CONFIG.selling.sales : (MACRO_CONFIG.selling && MACRO_CONFIG.selling.sales ? MACRO_CONFIG.selling.sales : {});
// command usa /vender mobs; sign mantém a placa calibrada como alternativa.
var SELLING_METHOD = String(configValue("selling", "method", "command")).toLowerCase();
if (SELLING_METHOD !== "command" && SELLING_METHOD !== "sign") SELLING_METHOD = "command";
var SELLING_COMMAND = String(configValue("selling", "command", "/vender mobs"));
var SELLING_COMMAND_WAIT_TICKS = Math.max(10, parseInt(configValue("selling", "commandWaitTicks", 20)) || 20);
var SELLING_COMMAND_ON_STORAGE_FAILURE = configValue("selling", "commandWhenStorageFails", true) === true || String(configValue("selling", "commandWhenStorageFails", true)).toLowerCase() === "true";
var SELLING_COMMAND_PROTECT_ITEMS = String(configValue("selling", "commandProtectItems", "minecraft:bow")).split(",").map(function (itemId) {
    return itemId.replace(/^\s+|\s+$/g, "");
}).filter(function (itemId) { return itemId !== ""; });
var AUTO_RESUME_AFTER_RELOG = configValue("behavior", "resumeAfterRelog", true);
var JUMP_AFTER_TELEPORT = configValue("behavior", "jumpAfterTeleport", true);
var AUTO_ATTACK_FARM = configValue("farm", "autoClick", true);
var LOCK_FARM_AIM = configValue("farm", "lockAim", true);
var AUTO_CLICK_INTERVAL_TICKS = Math.max(1, parseInt(configValue("farm", "clickIntervalTicks", 2)));
var TARGET_NEAREST_MOB = configValue("farm", "targetNearestMob", true);
var NEAREST_MOB_RANGE = Math.max(1, parseFloat(configValue("farm", "nearestMobRange", 4.5)) || 4.5);
var FARM_LOCATION_GUARD_RANGE = Math.max(2, parseFloat(configValue("farm", "locationGuardRange", 8)) || 8);
var NEAREST_MOB_TYPE = String(configValue("farm", "nearestMobType", "all")).toLowerCase();
if (NEAREST_MOB_TYPE !== "hostile" && NEAREST_MOB_TYPE !== "passive") NEAREST_MOB_TYPE = "all";
// Nunca trate a palavra "false" como verdadeira: em JavaScript ela é uma
// string válida e acabaria fazendo a busca subir/descer pelos baús. Só o
// booleano true ativa a varredura vertical.
var MATERIAL_SEARCH_ALL_ROWS = configValue("materials", "searchAllRows", false) === true;
// Mantido como fallback ao carregar config.yml antigo, sem maintenanceMode.
var AUTO_TOOL_REPLACEMENT = true;
// repair_then_replace: repara e troca a ferramenta caso não exista material.
// replace_only: não repara; troca a ferramenta baixa por uma reserva do baú.
// repair_only_stop: repara, mas desliga ao acabar o material (não troca a ferramenta).
var REPAIR_MAINTENANCE_MODE = String(configValue("repair", "maintenanceMode", AUTO_TOOL_REPLACEMENT ? "repair_then_replace" : "repair_only_stop")).toLowerCase();
if (REPAIR_MAINTENANCE_MODE !== "replace_only" && REPAIR_MAINTENANCE_MODE !== "replace_then_repair" && REPAIR_MAINTENANCE_MODE !== "repair_only_stop") {
    REPAIR_MAINTENANCE_MODE = "repair_then_replace";
}
var CHEST_OPEN_RETRIES = configValue("safety", "chestOpenRetries", 2);
var DEPOSIT_CHEST_OPEN_RETRIES = Math.max(1, parseInt(configValue("safety", "depositOpenRetries", CHEST_OPEN_RETRIES)) || CHEST_OPEN_RETRIES);
var RESTOCK_CHEST_OPEN_RETRIES = Math.max(1, parseInt(configValue("safety", "restockOpenRetries", CHEST_OPEN_RETRIES)) || CHEST_OPEN_RETRIES);
var CHEST_OPEN_WAIT_TICKS = configValue("safety", "chestOpenWaitTicks", 12);
var STORAGE_FAILURES_BEFORE_FRESH_START = Math.max(1, parseInt(configValue("storage", "failuresBeforeFreshStart", 3)) || 3);
var STATE_TIMEOUT_TICKS = Math.max(100, parseInt(configValue("safety", "stateTimeoutSeconds", 30)) * 20);
var AUTO_RESTART_ON_FAILURE = configValue("recovery", "autoRestart", true);
var AUTO_RESTART_DELAY_TICKS = Math.max(20, parseInt(configValue("recovery", "restartDelaySeconds", 3)) * 20);
var MAX_CONSECUTIVE_RESTARTS = Math.max(0, parseInt(configValue("recovery", "maxConsecutiveRestarts", 0)));
var RESTART_ON_REPAIR_NO_PROGRESS = configValue("recovery", "restartOnRepairNoProgress", true);
var RESTART_ON_STATE_TIMEOUT = configValue("recovery", "restartOnStateTimeout", true);

if (USE_SAVED_CHEST_CALIBRATION) {
    try {
        var savedChestCalibration = JSON.parse(FileLib.read("BolsoFarm", profileCalibrationFile()) || "{}");
        if (savedChestCalibration.pitch !== undefined && savedChestCalibration.pitch.length === 5) {
            CHEST_ROW_PITCH = savedChestCalibration.pitch;
        }
        if (savedChestCalibration.targets !== undefined && savedChestCalibration.targets.length === 5) {
            CHEST_ROW_TARGETS = savedChestCalibration.targets;
        }
    } catch (error) { }

}

try {
    repairAim = JSON.parse(FileLib.read("BolsoFarm", "data/repair-aim.json") || "null");
} catch (error) { reportError("carregar mira de reparo", error); repairAim = null; }

try {
    farmAim = JSON.parse(FileLib.read("BolsoFarm", farmAimFileForProfile(ACTIVE_PROFILE_NAME)) || "null");
} catch (error) { reportError("carregar mira da farm", error); farmAim = null; }

// ============================================================================
// ESTADO DA MÁQUINA E CONTADORES
// ============================================================================
var enabled = false;
var state = "IDLE";
var waitTicks = 0;
var pendingHomeConfirmCommand = null;
var pendingHomeConfirmTicks = 0;
var statusCooldown = 0;
var movementEnabled = configValue("farm", "continuousMovement", false);
var repairTarget = null;
var repairLastDamage = -1;
var repairNoProgressCycles = 0;
var repairWarpAttempts = 0;
var repairWarpWatchdogTicks = 0;
var repairAimWatchdogTicks = 0;
var repairFallbackAttempts = 0;
var farmWarpWatchdogTicks = 0;
var restockWarpWatchdogTicks = 0;
var storageWarpWatchdogTicks = 0;
var storageWaitWatchdogTicks = 0;
var toolRestockConfirmWatchdogTicks = 0;
var storageOpenMisses = 0;
var restockOpenMisses = 0;
var storageRealignAttempts = 0;
var STORAGE_REALIGN_ATTEMPTS = Math.max(0, parseInt(configValue("storage", "chestRealignAttempts", 2)) || 0);
var pendingStorageSlots = [];
var pendingDiscardSlots = [];
var storageColumn = 0;
var storageRow = 0;
var depositAttempt = null;
var chestOpenAttempts = 0;
var discardCooldownTicks = 0;
var storageMode = "DEPOSIT";
var teleportJumpTicks = 0;
var teleportJumpReleaseTicks = 0;
var teleportJumpRetries = 0;
var pauseNoticeShown = false;
var stats = { repairs: 0, storedStacks: 0, restocks: 0, toolRestocks: 0, chestColumns: 0, recoveries: 0, discardedStacks: 0, soldItems: 0 };
var sessionStartedAt = 0;
var observedState = "IDLE";
var stateStallTicks = 0;
var recoveryAttempts = 0;
var resumeStorage = false;
var resumeColumn = 0;
var resumeRow = 1;
var lastStorageColumn = 0;
var lastStorageRow = 1;
var DROP_BLACKLIST = [];
var DISCARD_ITEMS = [];
var DISCARD_ENABLED = configValue("discard", "enabled", true) === true;
var farmLastToolId = null;
var farmLastRemaining = -1;
var farmNoWearTicks = 0;
// Independente do loop principal: protege contra callbacks que congelam
// enquanto o jogador fica preso em um bloco da mobtrap.
var farmSafetyLastToolId = null;
var farmSafetyLastDamage = -1;
var farmSafetyNoProgressTicks = 0;
var farmWrongLocationTicks = 0;
// Slot da ferramenta escolhida ao entrar na farm. Não tem relação com a mira.
var farmToolSlot = -1;
// ID da ferramenta com que a execução atual foi iniciada (ex.: stone_sword).
var lockedRunToolId = null;
var runStartToolId = null;
var preferredReplacementToolId = null;
var FARM_STALL_TICKS = Math.max(20, parseInt(configValue("farm", "noWearReturnSeconds", 60)) * 20);
var autoClickTicks = 0;
var nearestMobDirectAttackAvailable = true;
var initialStartupRepairPending = false;
var pendingLowDurabilityRepair = false;
var sellingCurrent = null;
var commandSaleAfterProtection = false;
var sellingHitsLeft = 0;
var sellingAims = {};
var sellingCountBefore = 0;
var sellingNoProgressChecks = 0;
var sellingFailedThisCycle = false;
var storageFailedThisCycle = false;
var consecutiveStorageFailures = 0;
var sellingWarpWatchdogTicks = 0;
var sellingReadyWatchdogTicks = 0;
var periodicSaleTicks = 0;
var temporaryStorageHomeReady = false;
var temporaryStorageHomeCommand = null;
var temporaryStorageHomeTicks = 0;
var usingTemporaryStorageHome = false;
var restartTicks = 0;
var restartReason = null;
var consecutiveRestarts = 0;

try {
    DROP_BLACKLIST = JSON.parse(FileLib.read("BolsoFarm", "data/blacklist.json") || "[]");
} catch (error) { reportError("carregar lista preta", error); DROP_BLACKLIST = []; }

try {
    String(configValue("discard", "items", "")).split(",").forEach(function (itemId) {
        itemId = itemId.replace(/^\s+|\s+$/g, "");
        if (DISCARD_ENABLED && itemId !== "") DISCARD_ITEMS.push(itemId);
    });
} catch (error) { reportError("carregar itens para descarte", error); }

try {
    sellingAims = JSON.parse(FileLib.read("BolsoFarm", "data/sell-aims.json") || "{}");
} catch (error) { reportError("carregar miras de venda", error); sellingAims = {}; }

try {
    var savedStorageProgressText = FileLib.read("BolsoFarm", storageProgressFile()) || "";
    // Migração: aproveita o ponto antigo uma única vez se ainda não existir
    // arquivo próprio para o perfil atual.
    if (savedStorageProgressText.trim() === "") savedStorageProgressText = FileLib.read("BolsoFarm", "data/storage-progress.json") || "{}";
    var savedStorageProgress = JSON.parse(savedStorageProgressText);
    if (!isNaN(parseInt(savedStorageProgress.column))) lastStorageColumn = Math.max(0, parseInt(savedStorageProgress.column));
    if (!isNaN(parseInt(savedStorageProgress.row))) lastStorageRow = Math.max(1, Math.min(4, parseInt(savedStorageProgress.row)));
} catch (error) { reportError("carregar último baú de depósito", error); }

try {
    var savedStorageReturnText = FileLib.read("BolsoFarm", storageReturnFile()) || "";
    if (savedStorageReturnText.trim() === "") savedStorageReturnText = FileLib.read("BolsoFarm", "data/storage-return.json") || "{}";
    temporaryStorageHomeReady = JSON.parse(savedStorageReturnText).ready === true;
} catch (error) { temporaryStorageHomeReady = false; }

function rememberStorageChest() {
    if (!REMEMBER_LAST_STORAGE_CHEST) return;
    lastStorageColumn = storageColumn;
    lastStorageRow = storageRow;
    try {
        FileLib.write("BolsoFarm", storageProgressFile(), JSON.stringify({ column: lastStorageColumn, row: lastStorageRow }));
    } catch (error) { reportError("salvar último baú de depósito", error); }
}

function saveTemporaryStorageHome() {
    if (!USE_TEMPORARY_STORAGE_HOME || !REMEMBER_LAST_STORAGE_CHEST || temporaryStorageHomeCommand !== null) return;
    var command = setHomeCommandFromHomeCommand(HOME_STORAGE_TEMPORARY);
    if (command === null) return;
    temporaryStorageHomeCommand = command;
    temporaryStorageHomeTicks = TEMPORARY_STORAGE_HOME_CONFIRM_TICKS;
    ChatLib.say(command);
}

function beginTemporaryStorageHomeSave() {
    if (!USE_TEMPORARY_STORAGE_HOME || !REMEMBER_LAST_STORAGE_CHEST) return false;
    var command = setHomeCommandFromHomeCommand(HOME_STORAGE_TEMPORARY);
    if (command === null) return false;
    temporaryStorageHomeCommand = command;
    temporaryStorageHomeTicks = TEMPORARY_STORAGE_HOME_CONFIRM_TICKS;
    // Pausa neste baú até a confirmação, para nunca salvar a home em outro local.
    ChatLib.say(command);
    state = "STORAGE_TEMP_HOME_WAIT";
    waitTicks = 0;
    return true;
}

function confirmTemporaryStorageHome() {
    if (temporaryStorageHomeCommand === null) return;
    ChatLib.say(temporaryStorageHomeCommand);
    temporaryStorageHomeCommand = null;
    temporaryStorageHomeReady = true;
    try { FileLib.write("BolsoFarm", storageReturnFile(), JSON.stringify({ ready: true })); } catch (error) { }
    if (state === "STORAGE_TEMP_HOME_WAIT") {
        state = "STORAGE_DEPOSIT";
        waitTicks = 2;
    }
}

register("tick", function () {
    if (temporaryStorageHomeCommand === null) return;
    // Nunca confirma /sethome depois de sair do depósito: isso salvaria a home
    // temporária na mobtrap, reparo ou loja em vez do baú atual.
    if (state.indexOf("STORAGE") !== 0) {
        temporaryStorageHomeCommand = null;
        temporaryStorageHomeTicks = 0;
        return;
    }
    if (--temporaryStorageHomeTicks > 0) return;
    confirmTemporaryStorageHome();
});

register("chat", function (message) {
    if (temporaryStorageHomeCommand === null || state !== "STORAGE_TEMP_HOME_WAIT") return;
    var text = String(message || "").replace(/§[0-9A-FK-OR]/gi, "").toLowerCase();
    if (text.indexOf("já existe uma home") === -1 && text.indexOf("ja existe uma home") === -1) return;
    // A resposta confirma que o servidor recebeu o primeiro comando; conclui
    // rapidamente, mas ainda parado no baú.
    temporaryStorageHomeTicks = Math.min(temporaryStorageHomeTicks, 8);
}).setCriteria("${message}");

function invalidateTemporaryStorageHome(message) {
    temporaryStorageHomeReady = false;
    usingTemporaryStorageHome = false;
    temporaryStorageHomeCommand = null;
    temporaryStorageHomeTicks = 0;
    try { FileLib.write("BolsoFarm", storageReturnFile(), JSON.stringify({ ready: false })); } catch (error) { }
    ChatLib.chat(message);
}

function retryStorageFromMainHome(message) {
    // Uma home temporária pode ter sido apagada, sobrescrita manualmente ou não
    // confirmada pelo servidor. Nunca continua tentando depositar no local errado.
    invalidateTemporaryStorageHome(message);
    chestOpenAttempts = 0;
    usingTemporaryStorageHome = false;
    stopCombat();
    goHome(HOME_STORAGE);
    scheduleTeleportJump();
    state = "STORAGE_WARP";
    waitTicks = 50;
}

var TOOL_MATERIALS = {
    "minecraft:wooden_sword": "minecraft:planks",
    "minecraft:stone_sword": "minecraft:stone",
    "minecraft:iron_sword": "minecraft:iron_block",
    "minecraft:golden_sword": "minecraft:gold_block",
    "minecraft:diamond_sword": "minecraft:diamond_block",
    "minecraft:wooden_axe": "minecraft:planks",
    "minecraft:stone_axe": "minecraft:stone",
    "minecraft:iron_axe": "minecraft:iron_block",
    "minecraft:golden_axe": "minecraft:gold_block",
    "minecraft:diamond_axe": "minecraft:diamond_block"
};

var TOOL_PRIORITY = {
    "minecraft:diamond_sword": 50, "minecraft:diamond_axe": 49,
    "minecraft:iron_sword": 40, "minecraft:iron_axe": 39,
    "minecraft:stone_sword": 30, "minecraft:stone_axe": 29,
    "minecraft:golden_sword": 20, "minecraft:golden_axe": 19,
    "minecraft:wooden_sword": 10, "minecraft:wooden_axe": 9
};

function addConfiguredBlacklistItems() {
    try {
        var rawItems = configValue("blacklist", "items", "");
        var entries = String(rawItems).split(",");
        for (var i = 0; i < entries.length; i++) {
            var itemId = entries[i].replace(/^\s+|\s+$/g, "");
            if (itemId !== "" && DROP_BLACKLIST.indexOf(itemId) === -1) DROP_BLACKLIST.push(itemId);
        }
    } catch (error) { reportError("carregar blacklist do config.yml", error); }
}

function addConfiguredTools() {
    try {
        var configuredTools = MACRO_CONFIG.customTools;
        if (configuredTools === undefined || configuredTools === null) return;
        for (var name in configuredTools) {
            if (!configuredTools.hasOwnProperty(name)) continue;
            var tool = configuredTools[name];
            if (tool === null || tool.item === undefined || tool.repairMaterial === undefined) {
                ChatLib.chat("&e[BolsoFarm] Ferramenta extra '" + name + "' ignorada: use item e repairMaterial.");
                continue;
            }
            var itemId = String(tool.item);
            var materialId = String(tool.repairMaterial);
            if (itemId === "" || materialId === "") continue;
            TOOL_MATERIALS[itemId] = materialId;
            TOOL_PRIORITY[itemId] = isNaN(parseInt(tool.priority)) ? 60 : parseInt(tool.priority);
        }
    } catch (error) { reportError("carregar ferramentas extras do config.yml", error); }
}

// Os IDs do config.yml complementam — nunca removem — os itens vanilla e a
// blacklist já salva pelos comandos /rep banir e /rep desbanir.
addConfiguredBlacklistItems();
addConfiguredTools();

// ============================================================================
// CONTROLES DO CLIENTE, TELEPORTE E MIRA
// ============================================================================
function setKey(description, pressed) {
    try {
        var key = Client.getKeyBindFromDescription(description);
        if (key !== null) key.setState(pressed);
    } catch (error) { reportError("alterar tecla " + description, error); }
    // Fallback nativo do 1.8.9: registra a tecla no mesmo caminho usado pelo cliente.
    try {
        var settings = Client.getMinecraft().field_71474_y;
        var nativeKey = null;
        if (description === "key.jump") nativeKey = settings.field_74314_A;
        else if (description === "key.use") nativeKey = settings.field_74313_G;
        else if (description === "key.attack") nativeKey = settings.field_74312_F;
        else if (description === "key.forward") nativeKey = settings.field_74351_w;
        else if (description === "key.back") nativeKey = settings.field_74368_y;
        else if (description === "key.right") nativeKey = settings.field_74366_z;
        else if (description === "key.left") nativeKey = settings.field_74370_x;
        else if (description === "key.sneak") nativeKey = settings.field_74311_E;
        if (nativeKey !== null) {
            var KeyBinding = Java.type("net.minecraft.client.settings.KeyBinding");
            var keyCode = nativeKey.func_151463_i();
            KeyBinding.func_74510_a(keyCode, pressed);
            // setState sozinho não incrementa pressTime no 1.8.9. onTick cria o
            // evento que o Minecraft consome para chamar rightClickMouse.
            if (pressed && description === "key.use") KeyBinding.func_74507_a(keyCode);
        }
    } catch (ignored) { reportError("fallback da tecla " + description, ignored); }
}

function stopMovement() {
    setKey("key.forward", false);
    setKey("key.back", false);
    setKey("key.right", false);
    setKey("key.left", false);
    setKey("key.jump", false);
    setKey("key.sneak", false);
}

function closeCurrentScreen() {
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        if (player !== null) player.func_71053_j();
        // Garante que a GUI do baú anterior suma antes da próxima mira/click.
        if (minecraft.field_71462_r !== null) minecraft.func_147108_a(null);
    } catch (error) { reportError("fechar tela atual", error); }
    setKey("key.inventory", false);
}

function stopCombat() {
    // Para o ataque antes do warp, impedindo que a ferramenta continue perdendo usos.
    setKey("key.attack", false);
    setKey("key.use", false);
    stopMovement();
}

function goHome(command) {
    ChatLib.chat("&b[BolsoFarm] &7Indo para: &f" + command);
    ChatLib.say(command);
}

function scheduleTeleportJump() {
    // Um pulo curto após o servidor concluir a maioria dos warps, sem movimento contínuo.
    if (!JUMP_AFTER_TELEPORT) return;
    teleportJumpTicks = 25;
    teleportJumpReleaseTicks = 0;
    teleportJumpRetries = 1;
}

// Executa fora da máquina de estados: o pulo precisa ocorrer mesmo se a etapa
// seguinte do warp estiver aguardando/recuperando.
register("tick", function () {
    if (teleportJumpTicks > 0) {
        teleportJumpTicks--;
        if (teleportJumpTicks === 0) {
            setKey("key.jump", true);
            try { Client.getMinecraft().field_71439_g.func_70664_aZ(); }
            catch (error) { reportError("pulo pós-teleporte", error); }
            teleportJumpReleaseTicks = 2;
        }
        return;
    }
    if (teleportJumpReleaseTicks <= 0) return;
    teleportJumpReleaseTicks--;
    if (teleportJumpReleaseTicks !== 0) return;
    setKey("key.jump", false);
    if (teleportJumpRetries > 0) {
        teleportJumpRetries--;
        teleportJumpTicks = 20;
    }
});

// ============================================================================
// WATCHDOGS DE RECUPERAÇÃO (warps, depósito, reposição e reparo)
// ============================================================================
// Equivalente para o depósito de drops: não deixa STORAGE_WARP parado na home
// dos baús quando o agendador principal não consome waitTicks.
register("tick", function () {
    if (!enabled || (state !== "STORAGE_WARP" && state !== "STORAGE_FALLBACK_WAIT" && state !== "STORAGE_FALLBACK_DEPOSIT" && state !== "STORAGE_FALLBACK_CONFIRM" && state !== "STORAGE_FALLBACK_MOVE" && state !== "STORAGE_FALLBACK_AIM" && state !== "STORAGE_FALLBACK_ALIGN")) {
        storageWarpWatchdogTicks = 0;
        storageOpenMisses = 0;
        return;
    }
    storageWarpWatchdogTicks++;
    try {
        if (state === "STORAGE_FALLBACK_ALIGN") {
            if (storageWarpWatchdogTicks < 3) return;
            storageWarpWatchdogTicks = 0;
            setKey("key.right", false);
            setKey("key.sneak", false);
            aimAtStorageRow();
            state = "STORAGE_FALLBACK_AIM";
            return;
        }
        if (state === "STORAGE_FALLBACK_MOVE") {
            if (storageWarpWatchdogTicks < CHEST_STEP_TICKS) return;
            storageWarpWatchdogTicks = 0;
            setKey("key.right", false);
            setKey("key.sneak", false);
            aimAtStorageRow();
            state = "STORAGE_FALLBACK_AIM";
            return;
        }
        if (state === "STORAGE_FALLBACK_AIM") {
            if (storageWarpWatchdogTicks < 3) return;
            storageWarpWatchdogTicks = 0;
            openAimedStorageChestDirect();
            state = "STORAGE_FALLBACK_WAIT";
            return;
        }
        if (state === "STORAGE_WARP") {
            if (storageWarpWatchdogTicks < 100) return;
            storageWarpWatchdogTicks = 0;
            aimAtStorageRow();
            state = "STORAGE_FALLBACK_AIM";
            appendDiagnostic("RECUPERAÇÃO", "STORAGE_WARP travado; abrindo baú para depósito.");
            return;
        }
        if (state === "STORAGE_FALLBACK_WAIT") {
            if (storageWarpWatchdogTicks < 15) return;
            storageWarpWatchdogTicks = 0;
            var storageFallbackContainer = Player.getContainer();
            if (storageFallbackContainer === null || storageFallbackContainer.getSize() < 63) {
                storageOpenMisses++;
                if (storageOpenMisses >= 2) {
                    storageOpenMisses = 0;
                    setKey("key.sneak", true);
                    setKey("key.right", true);
                    state = "STORAGE_FALLBACK_ALIGN";
                    appendDiagnostic("RECUPERAÇÃO", "baú não abriu; ajustando posição lateral.");
                } else {
                    aimAtStorageRow();
                    state = "STORAGE_FALLBACK_AIM";
                }
                return;
            }
            storageOpenMisses = 0;
            state = "STORAGE_FALLBACK_DEPOSIT";
            return;
        }
        if (state === "STORAGE_FALLBACK_DEPOSIT") {
            if (storageWarpWatchdogTicks < 2) return;
            storageWarpWatchdogTicks = 0;
            if (pendingStorageSlots.length === 0) {
                closeCurrentScreen();
                appendDiagnostic("RECUPERAÇÃO", "depósito concluído pelo watchdog.");
                finishStorageAfterDeposit("&a[BolsoFarm] Inventário guardado pelo modo de segurança; voltando ao farm.");
                return;
            }
            var fallbackPlayerSlot = pendingStorageSlots[0];
            var fallbackStack = Player.getInventory().getStackInSlot(fallbackPlayerSlot);
            if (fallbackStack === null) {
                pendingStorageSlots.shift();
                return;
            }
            depositAttempt = { playerSlot: fallbackPlayerSlot, registryName: fallbackStack.getRegistryName(), stackSize: fallbackStack.getStackSize(), checks: 0 };
            Player.getContainer().click(storageContainerSlot(Player.getContainer(), fallbackPlayerSlot), true);
            state = "STORAGE_FALLBACK_CONFIRM";
            return;
        }
        // Uma mudança de estado (por exemplo, confirmação da home temporária)
        // pode limpar a tentativa enquanto este watchdog ainda roda. Retoma o
        // depósito sem acessar .checks de null.
        if (depositAttempt === null) {
            state = "STORAGE_FALLBACK_DEPOSIT";
            storageWarpWatchdogTicks = 0;
            return;
        }
        // A primeira confirmação é rápida; só espera mais quando o servidor
        // ainda não refletiu a pilha, evitando travar o depósito normal.
        var confirmDelay = (depositAttempt.checks || 0) === 0 ? 6 : 20;
        if (storageWarpWatchdogTicks < confirmDelay) return;
        storageWarpWatchdogTicks = 0;
        var fallbackRemaining = Player.getInventory().getStackInSlot(depositAttempt.playerSlot);
        var fallbackUnchanged = fallbackRemaining !== null && fallbackRemaining.getRegistryName() === depositAttempt.registryName && fallbackRemaining.getStackSize() === depositAttempt.stackSize;
        if (fallbackUnchanged) {
            depositAttempt.checks = (depositAttempt.checks || 0) + 1;
            if (depositAttempt.checks < 2) return;
            fallbackAdvanceStorageTarget();
            return;
        }
        pendingStorageSlots.shift();
        stats.storedStacks++;
        consecutiveStorageFailures = 0;
        rememberStorageChest();
        state = "STORAGE_FALLBACK_DEPOSIT";
    } catch (error) { reportError("watchdog de depósito no baú", error); }
});

// ============================================================================
// HELPERS DE REPARO, INVENTÁRIO E BAÚS
// ============================================================================
function isAtRepairHome() {
    try {
        if (repairAim === null || repairAim.target === undefined) return false;
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) return false;
        var target = repairAim.target;
        var dx = player.field_70165_t - (target.x + 0.5);
        var dy = player.field_70163_u - (target.y + 0.5);
        var dz = player.field_70161_v - (target.z + 0.5);
        return (dx * dx + dy * dy + dz * dz) <= 36;
    } catch (error) { reportError("confirmar posição da home de reparo", error); return false; }
}

function setHomeWithConfirmation(command) {
    ChatLib.say(command);
    pendingHomeConfirmCommand = command;
    pendingHomeConfirmTicks = 20;
}

register("tick", function () {
    if (pendingHomeConfirmCommand === null) return;
    pendingHomeConfirmTicks--;
    if (pendingHomeConfirmTicks <= 0) {
        ChatLib.say(pendingHomeConfirmCommand);
        pendingHomeConfirmCommand = null;
    }
});

// Recupera a retirada de material quando RESTOCK_WARP fica com a espera
// congelada. Usa o mesmo alvo calibrado do baú, sem depender do agendador
// principal que falhou nos warps deste cliente.
register("tick", function () {
    if (!enabled || (state !== "RESTOCK_WARP" && state !== "RESTOCK_FALLBACK_WAIT" && state !== "RESTOCK_FALLBACK_CONFIRM" && state !== "RESTOCK_FALLBACK_MOVE" && state !== "RESTOCK_FALLBACK_AIM" && state !== "RESTOCK_FALLBACK_ALIGN")) {
        restockWarpWatchdogTicks = 0;
        restockOpenMisses = 0;
        return;
    }
    restockWarpWatchdogTicks++;
    try {
        if (state === "RESTOCK_FALLBACK_ALIGN") {
            if (restockWarpWatchdogTicks < 3) return;
            restockWarpWatchdogTicks = 0;
            setKey("key.right", false);
            setKey("key.sneak", false);
            aimAtStorageRow();
            state = "RESTOCK_FALLBACK_AIM";
            return;
        }
        if (state === "RESTOCK_FALLBACK_MOVE") {
            if (restockWarpWatchdogTicks < CHEST_STEP_TICKS) return;
            restockWarpWatchdogTicks = 0;
            setKey("key.right", false);
            setKey("key.sneak", false);
            aimAtStorageRow();
            state = "RESTOCK_FALLBACK_AIM";
            return;
        }
        if (state === "RESTOCK_FALLBACK_AIM") {
            if (restockWarpWatchdogTicks < 3) return;
            restockWarpWatchdogTicks = 0;
            openAimedStorageChestDirect();
            state = "RESTOCK_FALLBACK_WAIT";
            return;
        }
        if (state === "RESTOCK_WARP") {
            if (restockWarpWatchdogTicks < 100) return;
            restockWarpWatchdogTicks = 0;
            aimAtStorageRow();
            state = "RESTOCK_FALLBACK_AIM";
            appendDiagnostic("RECUPERAÇÃO", "RESTOCK_WARP travado; abrindo baú de material diretamente.");
            return;
        }

        if (state === "RESTOCK_FALLBACK_WAIT") {
            if (restockWarpWatchdogTicks < 15) return;
            restockWarpWatchdogTicks = 0;
            var fallbackContainer = Player.getContainer();
            if (fallbackContainer === null || fallbackContainer.getSize() < 63) {
                restockOpenMisses++;
                if (restockOpenMisses >= 2) {
                    restockOpenMisses = 0;
                    setKey("key.sneak", true);
                    setKey("key.right", true);
                    state = "RESTOCK_FALLBACK_ALIGN";
                    appendDiagnostic("RECUPERAÇÃO", "baú de material não abriu; ajustando posição lateral.");
                } else {
                    aimAtStorageRow();
                    state = "RESTOCK_FALLBACK_AIM";
                }
                return;
            }
            restockOpenMisses = 0;
            if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
                var fallbackToolSlot = findToolInOpenChest(fallbackContainer);
                if (fallbackToolSlot === -1) {
                    fallbackNextMaterialChest();
                    return;
                }
                var fallbackHeldSlot = getHeldHotbarIndex();
                fallbackContainer.click(fallbackToolSlot, false);
                fallbackContainer.click(storageContainerSlot(fallbackContainer, fallbackHeldSlot), false);
                // Na troca, devolve a ferramenta anterior ao mesmo slot do baú.
                if (storageMode === "REPLACE") fallbackContainer.click(fallbackToolSlot, false);
            } else {
                if (repairTarget === null || storageMode !== "RESTOCK") {
                    scheduleAutoRestart("baú aberto sem alvo de material para reparo.", "repair");
                    return;
                }
                var fallbackMaterialSlot = findMaterialInOpenChest(fallbackContainer, repairTarget.materialId);
                if (fallbackMaterialSlot === -1) {
                    fallbackNextMaterialChest();
                    return;
                }
                fallbackContainer.click(fallbackMaterialSlot, true);
            }
            state = "RESTOCK_FALLBACK_CONFIRM";
            appendDiagnostic("RECUPERAÇÃO", "item de reposição retirado do baú pelo watchdog.");
            return;
        }

        if (restockWarpWatchdogTicks < 8) return;
        restockWarpWatchdogTicks = 0;
        if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
            var fallbackTool = findHotbarTool();
            if (fallbackTool === null || !selectHotbarSlot(fallbackTool.slot)) {
                scheduleAutoRestart("a ferramenta retirada não chegou à hotbar.", "repair");
                return;
            }
            farmToolSlot = fallbackTool.slot;
            preferredReplacementToolId = null;
            closeCurrentScreen();
            stats.toolRestocks++;
            appendDiagnostic("RECUPERAÇÃO", "ferramenta confirmada; voltando à farm.");
            returnToFarm("&a[BolsoFarm] Ferramenta reposta pelo modo de segurança; voltando ao farm.");
            return;
        }
        if (countMaterial(repairTarget.materialId) <= 0) {
            scheduleAutoRestart("o material não entrou no inventário.", "repair");
            return;
        }
        closeCurrentScreen();
        stats.restocks++;
        appendDiagnostic("RECUPERAÇÃO", "material confirmado; retomando reparo.");
        startRepair(repairTarget);
    } catch (error) { reportError("watchdog de busca de material", error); }
});

// Continua o reparo mesmo se o callback principal ficar preso na espera de
// mira. O log mostrou REPAIR_AIM_WAIT com waitTicks=5 por vários segundos.
register("tick", function () {
    if (!enabled || (state !== "REPAIR_AIM_WAIT" && state !== "REPAIR_FALLBACK_WAIT")) {
        repairAimWatchdogTicks = 0;
        repairFallbackAttempts = 0;
        return;
    }
    repairAimWatchdogTicks++;
    try {
        if (state === "REPAIR_AIM_WAIT") {
            if (repairAimWatchdogTicks < 30) return;
            repairAimWatchdogTicks = 0;
            repairFallbackAttempts = 1;
            if (!ensureRepairToolSelected()) {
                scheduleAutoRestart("a espada de reparo não está mais na hotbar.", "repair");
                return;
            }
            useSavedRepairBlock();
            state = "REPAIR_FALLBACK_WAIT";
            appendDiagnostic("RECUPERAÇÃO", "REPAIR_AIM_WAIT travado; clique direto enviado ao bloco.");
            return;
        }

        if (repairAimWatchdogTicks < 12) return;
        repairAimWatchdogTicks = 0;
        var fallbackItem = Player.getHeldItem();
        if (fallbackItem !== null && fallbackItem.getMaxDamage() > 0 && fallbackItem.getDamage() <= 0) {
            repairTarget = null;
            stats.repairs++;
            appendDiagnostic("RECUPERAÇÃO", "reparo confirmado pelo watchdog.");
            returnToFarm("&a[BolsoFarm] Reparo concluído pelo modo de segurança; voltando ao farm.");
            return;
        }
        if (repairFallbackAttempts < 3) {
            repairFallbackAttempts++;
            if (!ensureRepairToolSelected()) {
                scheduleAutoRestart("a espada de reparo não está mais na hotbar.", "repair");
                return;
            }
            useSavedRepairBlock();
            appendDiagnostic("RECUPERAÇÃO", "repetindo clique de reparo (tentativa " + repairFallbackAttempts + ").");
            return;
        }
        scheduleAutoRestart("bloco de ferro não confirmou o reparo após o watchdog.", "repair");
    } catch (error) { reportError("watchdog do clique de reparo", error); }
});

register("tick", function () {
    if (!enabled || state !== "FARMING") {
        farmSafetyLastToolId = null;
        farmSafetyLastDamage = -1;
        farmSafetyNoProgressTicks = 0;
        return;
    }
    try {
        var safetyHeldItem = Player.getHeldItem();
        var safetyToolId = safetyHeldItem === null ? "" : safetyHeldItem.getRegistryName();
        var safetyDamage = safetyHeldItem === null || safetyHeldItem.getMaxDamage() <= 0 ? -1 : safetyHeldItem.getDamage();
        // Qualquer desgaste confirma que a farm continua progredindo.
        if (safetyToolId !== farmSafetyLastToolId || safetyDamage !== farmSafetyLastDamage) {
            farmSafetyLastToolId = safetyToolId;
            farmSafetyLastDamage = safetyDamage;
            farmSafetyNoProgressTicks = 0;
            return;
        }
        farmSafetyNoProgressTicks++;
        if (farmSafetyNoProgressTicks < FARM_STALL_TICKS) return;
        farmSafetyNoProgressTicks = 0;
        stopCombat();
        appendDiagnostic("RECUPERAÇÃO", "farm sem progresso por " + Math.round(FARM_STALL_TICKS / 20) + "s; retornando à /home mob pelo watchdog.");
        returnToFarm("&e[BolsoFarm] Farm travada sem progresso; voltando para " + HOME_FARM + ".");
    } catch (error) { reportError("watchdog de farm sem progresso", error); }
});

register("tick", function () {
    if (!enabled || state !== "FARMING" || !LOCK_FARM_AIM || farmAim === null) return;
    aimAtFarm();
});

function disableForMissingMaterial(message) {
    enabled = false;
    state = "IDLE";
    repairTarget = null;
    pendingStorageSlots = [];
    teleportJumpTicks = 0;
    teleportJumpReleaseTicks = 0;
    teleportJumpRetries = 0;
    stopCombat();
    ChatLib.chat("&c[BolsoFarm] DESLIGADA: " + message);
    showSessionStatistics();
    // No modo de ciclo, uma fase sem recurso não fica parada: depois de todos
    // os retries normais, o coordenador a substitui pela fase seguinte.
    try { ChatLib.command("bolsociclo complete farm", true); } catch (ignoredCycle) { }
}

function handleMissingRepairMaterial(target) {
    if (REPAIR_MAINTENANCE_MODE === "repair_then_replace") {
        // Se uma reserva de outro tipo não tem seu material disponível, devolve-a
        // no swap e procura novamente o mesmo tipo que iniciou esta execução.
        if (!SAME_TOOL_TYPE_ONLY && FALLBACK_TO_START_TOOL_ON_MISSING_MATERIAL &&
            runStartToolId !== null && target.toolId !== runStartToolId) {
            preferredReplacementToolId = runStartToolId;
            ChatLib.chat("&e[BolsoFarm] Sem material para " + target.name + "; devolvendo-a e procurando " + runStartToolId + ".");
        }
        beginToolReplacement(target);
        return;
    }
    disableForMissingMaterial("acabou " + materialName(target.materialId) + "; modo " + REPAIR_MAINTENANCE_MODE + " não troca a ferramenta.");
}

function beginSelectedMaintenance(target) {
    if (REPAIR_MAINTENANCE_MODE === "replace_only" || REPAIR_MAINTENANCE_MODE === "replace_then_repair") {
        beginToolReplacement(target);
        return;
    }
    if (countMaterial(target.materialId) <= 0) {
        if (REPAIR_MAINTENANCE_MODE === "repair_only_stop") {
            disableForMissingMaterial("não há " + materialName(target.materialId) + " para reparar; modo somente reparar.");
        } else {
            beginMaterialRestock(target);
        }
        return;
    }
    startRepair(target);
}

function aimAtStorageRow() {
    try {
        // Usa a entidade crua do Minecraft 1.8.9; o wrapper Player não muda a câmera.
        var player = Client.getMinecraft().field_71439_g;
        if (player !== null) {
            player.field_70177_z = 180.0; // Norte
            player.field_70125_A = CHEST_ROW_PITCH[storageRow];
            player.field_70126_B = player.field_70177_z;
            player.field_70127_C = player.field_70125_A;
        }
    } catch (error) { reportError("mirar linha de baús", error); }
}

function clickSavedChestTarget() {
    // Mantido por compatibilidade com fluxos antigos: usa o mesmo clique nativo
    // que o caminho atual de baús, sem sobrecarga do PlayerControllerMP.
    return openAimedStorageChestDirect();
}

function savedStorageChestHit() {
    // A calibração é feita na primeira coluna. Com a parede voltada ao norte,
    // cada movimento para a direita avança uma posição no eixo X.
    if (!USE_SAVED_CHEST_CALIBRATION) return null;
    var target = CHEST_ROW_TARGETS[storageRow];
    if (target === null || target === undefined) return null;
    if (isNaN(target.x) || isNaN(target.y) || isNaN(target.z)) return null;

    try {
        var BlockPos = Java.type("net.minecraft.util.BlockPos");
        var EnumFacing = Java.type("net.minecraft.util.EnumFacing");
        var Vec3 = Java.type("net.minecraft.util.Vec3");
        var MovingObjectPosition = Java.type("net.minecraft.util.MovingObjectPosition");
        var x = Number(target.x) + storageColumn;
        var y = Number(target.y);
        var z = Number(target.z);
        var pos = new BlockPos(x, y, z);
        var side = EnumFacing.valueOf(String(target.side || "SOUTH").toUpperCase());
        return new MovingObjectPosition(new Vec3(x + 0.5, y + 0.5, z + 0.5), side, pos);
    } catch (error) {
        reportError("montar alvo calibrado do baú", error);
        return null;
    }
}

function openAimedStorageChestDirect() {
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        var savedHit = savedStorageChestHit();

        // Caminho preciso: usa a coordenada calibrada da linha/coluna atual.
        if (savedHit !== null) {
            minecraft.field_71476_x = savedHit;
            minecraft.func_147121_ag();
            return true;
        }

        // Fallback para instalações antigas ou calibração incompleta.
        aimAtStorageRow();
        // Recalcula o alvo com a rotação da altura atual. Em alguns clientes o
        // field_71476_x continua apontando para o baú do meio por vários ticks.
        minecraft.field_71476_x = player.func_174822_a(5.0, 1.0);
        // A mira já teve alguns ticks para atualizar o ray trace. O clique
        // nativo evita ambiguidade de sobrecarga do PlayerControllerMP no CT.
        minecraft.func_147121_ag();
        return true;
    } catch (error) {
        reportError("abrir baú pela mira", error);
        setKey("key.use", true);
        return false;
    }
}

function aimAtRepairBlock() {
    if (repairAim === null) return;
    try {
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) return;
        player.field_70177_z = repairAim.yaw;
        player.field_70125_A = repairAim.pitch;
        player.field_70126_B = repairAim.yaw;
        player.field_70127_C = repairAim.pitch;
    } catch (error) { reportError("mirar no bloco de reparo", error); }
}

function findNearbyRepairBlock() {
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        var world = minecraft.field_71441_e;
        var BlockPos = Java.type("net.minecraft.util.BlockPos");
        var Block = Java.type("net.minecraft.block.Block");
        var baseX = Math.floor(player.field_70165_t);
        var baseY = Math.floor(player.field_70163_u);
        var baseZ = Math.floor(player.field_70161_v);
        var best = null;
        var bestDistance = 999;
        for (var x = -4; x <= 4; x++) for (var y = -3; y <= 3; y++) for (var z = -4; z <= 4; z++) {
            var pos = new BlockPos(baseX + x, baseY + y, baseZ + z);
            var block = world.func_180495_p(pos).func_177230_c();
            // ID vanilla 42 = bloco de ferro no Minecraft 1.8.9.
            if (Block.func_149682_b(block) !== 42) continue;
            var dx = (baseX + x + 0.5) - player.field_70165_t;
            var dy = (baseY + y + 0.5) - (player.field_70163_u + player.func_70047_e());
            var dz = (baseZ + z + 0.5) - player.field_70161_v;
            var distance = dx * dx + dy * dy + dz * dz;
            if (distance <= 20.25 && distance < bestDistance) {
                bestDistance = distance;
                var ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
                // A face clicada é a que aponta para o jogador, portanto é o
                // oposto do vetor jogador -> centro do bloco. A versão anterior
                // usava a face oposta: a câmera mirava no ferro, mas o pacote de
                // uso chegava ao servidor como se tivesse atingido o outro lado.
                var face = ay >= ax && ay >= az ? (dy > 0 ? "DOWN" : "UP") :
                    (ax >= az ? (dx > 0 ? "WEST" : "EAST") : (dz > 0 ? "NORTH" : "SOUTH"));
                best = { x: baseX + x, y: baseY + y, z: baseZ + z, dx: dx, dy: dy, dz: dz, side: face };
            }
        }
        return best;
    } catch (error) { reportError("procurar bloco de ferro", error); return null; }
}

function aimAtRepairTarget(target) {
    var horizontal = Math.sqrt(target.dx * target.dx + target.dz * target.dz);
    repairAim = {
        yaw: Math.atan2(target.dz, target.dx) * 180 / Math.PI - 90,
        pitch: -(Math.atan2(target.dy, horizontal) * 180 / Math.PI),
        target: { x: target.x, y: target.y, z: target.z, side: target.side }
    };
    aimAtRepairBlock();
}

function clickSavedRepairBlock() {
    if (repairAim === null || repairAim.target === undefined) return false;
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        var target = repairAim.target;
        aimAtRepairBlock();
        // No 1.8.9, esta é a interação direita nativa com bloco. Ao usar objetos
        // Minecraft (não wrappers do CT), o pacote chega ao servidor mesmo quando
        // o clique físico não é consumido pela janela.
        try {
            var BlockPos = Java.type("net.minecraft.util.BlockPos");
            var EnumFacing = Java.type("net.minecraft.util.EnumFacing");
            var Vec3 = Java.type("net.minecraft.util.Vec3");
            var pos = new BlockPos(target.x, target.y, target.z);
            var side = EnumFacing.valueOf(String(target.side));
            var hit = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
            minecraft.field_71442_b.func_178890_a(
                player,
                minecraft.field_71441_e,
                player.func_70694_bm(),
                pos,
                side,
                hit
            );
            setKey("key.use", true);
            return true;
        } catch (directError) {
            appendDiagnostic("REPARO", "interação direta indisponível; usando clique nativo: " + directError);
        }
        // Atualiza o alvo sob a mira antes do rightClickMouse nativo. Isso evita
        // a chamada sobrecarregada ausente em alguns CT 1.8.9.
        minecraft.field_71476_x = player.func_174822_a(5.0, 1.0);
        minecraft.func_147121_ag();
        setKey("key.use", true);
        return true;
    } catch (error) {
        reportError("interagir com bloco de reparo", error);
        return false;
    }
}

function useSavedRepairBlock() {
    // O rightClickMouse pode falhar silenciosamente quando a janela do Minecraft
    // não está com foco. Usa primeiro o PlayerControllerMP do 1.8.9, que envia a
    // interação C08 diretamente para o bloco salvo.
    aimAtRepairBlock();
    if (clickSavedRepairBlock()) return true;
    try {
        Client.getMinecraft().func_147121_ag();
        return true;
    } catch (error) {
        reportError("clique nativo de reparo", error);
        // Reserva apenas para clientes onde o método interno esteja indisponível.
        setKey("key.use", true);
        return true;
    }
}

function aimAtFarm() {
    if (farmAim === null) return;
    try {
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) return;
        player.field_70177_z = farmAim.yaw;
        player.field_70125_A = farmAim.pitch;
        player.field_70126_B = farmAim.yaw;
        player.field_70127_C = farmAim.pitch;
    } catch (error) { reportError("fixar mira da farm", error); }
}

function isAtFarmHome() {
    try {
        if (farmAim === null || farmAim.target === undefined) return true;
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) return false;
        var target = farmAim.target;
        var dx = player.field_70165_t - target.x;
        var dy = player.field_70163_u - target.y;
        var dz = player.field_70161_v - target.z;
        return (dx * dx + dy * dy + dz * dz) <= FARM_LOCATION_GUARD_RANGE * FARM_LOCATION_GUARD_RANGE;
    } catch (error) { return true; }
}

function findNearestFarmMob() {
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        var world = minecraft.field_71441_e;
        if (player === null || world === null) return null;
        var entities = world.field_72996_f;
        var maxDistanceSquared = NEAREST_MOB_RANGE * NEAREST_MOB_RANGE;
        var nearest = null;
        var nearestDistance = maxDistanceSquared;
        // ChatTriggers pode expor loadedEntityList como Object[] Java ou como
        // java.util.List. Tenta a reflexão primeiro: alguns bridges reportam
        // isArray() incorretamente, mas Array.getLength é a detecção segura.
        var JavaArray = Java.type("java.lang.reflect.Array");
        var entitiesAreArray = true;
        var entityCount;
        try {
            entityCount = JavaArray.getLength(entities);
        } catch (notJavaArray) {
            entitiesAreArray = false;
            entityCount = entities.size();
        }
        for (var i = 0; i < entityCount; i++) {
            var entity = entitiesAreArray ? JavaArray.get(entities, i) : entities.get(i);
            if (entity === null || entity === player || entity.field_70128_L) continue;
            var className = String(entity.getClass().getName());
            // Não ataca jogador, item, flecha, armor stand nem entidade sem vida.
            if (className.indexOf("entity.player") >= 0 || className.indexOf("ArmorStand") >= 0 ||
                typeof entity.func_110143_aJ !== "function" || entity.func_110143_aJ() <= 0) continue;
            // No vanilla 1.8.9 mobs hostis ficam no pacote entity.monster.
            // Em servidores com mobs customizados, use all para não ignorá-los.
            var hostile = className.indexOf("entity.monster") >= 0;
            if ((NEAREST_MOB_TYPE === "hostile" && !hostile) ||
                (NEAREST_MOB_TYPE === "passive" && hostile)) continue;
            var dx = entity.field_70165_t - player.field_70165_t;
            var dy = entity.field_70163_u - player.field_70163_u;
            var dz = entity.field_70161_v - player.field_70161_v;
            var distance = dx * dx + dy * dy + dz * dz;
            if (distance < nearestDistance) {
                nearest = entity;
                nearestDistance = distance;
            }
        }
        return nearest;
    } catch (error) { reportError("procurar mob mais próximo", error); return null; }
}

function aimAtFarmMob(entity) {
    var player = Client.getMinecraft().field_71439_g;
    var dx = entity.field_70165_t - player.field_70165_t;
    var dz = entity.field_70161_v - player.field_70161_v;
    var dy = (entity.field_70163_u + entity.func_70047_e()) - (player.field_70163_u + player.func_70047_e());
    var horizontal = Math.sqrt(dx * dx + dz * dz);
    var yaw = Math.atan2(dz, dx) * 180 / Math.PI - 90;
    var pitch = -(Math.atan2(dy, horizontal) * 180 / Math.PI);
    player.field_70177_z = yaw;
    player.field_70125_A = pitch;
    player.field_70126_B = yaw;
    player.field_70127_C = pitch;
}

function attackNearestFarmMob() {
    var target = findNearestFarmMob();
    if (target === null) return false;
    var minecraft = Client.getMinecraft();
    var player = minecraft.field_71439_g;
    aimAtFarmMob(target);
    if (nearestMobDirectAttackAvailable) {
        try {
            minecraft.field_71442_b.func_78764_a(player, target);
            player.func_71038_i();
            return true;
        } catch (error) {
            // Alguns forks do 1.8.9 expõem outro nome para attackEntity.
            // A mira já está no mob, então o clique vanilla continua sendo seguro.
            nearestMobDirectAttackAvailable = false;
            appendDiagnostic("FARM", "ataque direto indisponível; usando clique vanilla no mob mais próximo.");
        }
    }
    minecraft.func_147116_af();
    return true;
}

function resumeMovement() {
    if (movementEnabled && state === "FARMING") setKey("key.forward", true);
}

function materialName(materialId) {
    if (materialId === "minecraft:planks") return "tábuas de madeira";
    if (materialId === "minecraft:stone") return "pedra lisa";
    if (materialId === "minecraft:iron_block") return "bloco de ferro";
    if (materialId === "minecraft:gold_block") return "bloco de ouro";
    if (materialId === "minecraft:diamond_block") return "bloco de diamante";
    return materialId;
}

function isRepairMaterial(item, materialId) {
    if (item === null || item.getRegistryName() !== materialId) return false;
    // Em 1.8.9, pedra lisa é minecraft:stone com metadata 0.
    return materialId !== "minecraft:stone" || item.getDamage() === 0;
}

function isBlacklisted(item) {
    return item !== null && DROP_BLACKLIST.indexOf(item.getRegistryName()) !== -1;
}

// Descarta antes de preparar o depósito. Assim flechas não ocupam vaga nem
// entram em baús; este é um clique de Container interno do Minecraft, não um
// clique físico do mouse do Windows.
function discardConfiguredItems() {
    var inventory = Player.getInventory();
    if (inventory === null || DISCARD_ITEMS.length === 0) return false;
    try {
        for (var slot = 0; slot < inventory.getSize(); slot++) {
            var item = inventory.getStackInSlot(slot);
            if (item === null || DISCARD_ITEMS.indexOf(item.getRegistryName()) === -1) continue;
            // O inventário pode demorar alguns ticks para refletir o drop. Durante
            // esse intervalo não clicamos novamente no mesmo slot.
            if (discardCooldownTicks > 0) return true;
            var player = Client.getMinecraft().field_71439_g;
            // Slots 0–8 são a hotbar e ficam no fim do Container do jogador.
            var containerSlot = slot < 9 ? 36 + slot : slot;
            Client.getMinecraft().field_71442_b.func_78753_a(
                player.field_71069_bz.field_75152_c, containerSlot, 1, 4, player
            );
            discardCooldownTicks = Math.max(2, parseInt(configValue("discard", "delayTicks", 6)) || 6);
            stats.discardedStacks++;
            appendDiagnostic("DESCARTE", "jogada fora pilha de " + item.getRegistryName() + ".");
            return true;
        }
    } catch (error) { reportError("descartar drop configurado", error); }
    return false;
}

function saveBlacklist() {
    FileLib.write("BolsoFarm", "data/blacklist.json", JSON.stringify(DROP_BLACKLIST));
}

function findRepairTarget() {
    var inventory = Player.getInventory();
    if (inventory === null) return null;

    var best = null;
    // O reparador do servidor atua na ferramenta empunhada; por isso a busca
    // de baixa durabilidade fica restrita à hotbar, que pode ser selecionada com segurança.
    for (var slot = 0; slot < Math.min(9, inventory.getSize()); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (item === null || item.getMaxDamage() <= 0) continue;

        var material = TOOL_MATERIALS[item.getRegistryName()];
        if (material === undefined) continue;

        var remaining = item.getMaxDamage() - item.getDamage();
        if (best === null || remaining < best.remaining) {
            best = {
                slot: slot,
                name: ChatLib.removeFormatting(item.getName()),
                toolId: item.getRegistryName(),
                materialId: material,
                remaining: remaining
            };
        }
    }
    return best;
}

function getHeldHotbarIndex() {
    try { return Player.getHeldItemIndex(); }
    catch (error) {
        try { return Client.getMinecraft().field_71439_g.field_71071_by.field_70461_c; }
        catch (ignored) { return 0; }
    }
}

function selectHotbarSlot(slot) {
    if (slot < 0 || slot > 8) return false;
    try {
        if (getHeldHotbarIndex() === slot) return true;
        // API do CT quando disponível.
        Player.setHeldItemIndex(slot);
        if (getHeldHotbarIndex() === slot) return true;
    } catch (error) { reportError("selecionar slot da ferramenta", error); }
    try {
        // Fallback nativo para CT 1.8.9: atualiza cliente e servidor.
        var player = Client.getMinecraft().field_71439_g;
        var HeldItemChange = Java.type("net.minecraft.network.play.client.C09PacketHeldItemChange");
        player.field_71071_by.field_70461_c = slot;
        player.field_71174_a.func_147297_a(new HeldItemChange(slot));
        return getHeldHotbarIndex() === slot;
    } catch (error) {
        reportError("fallback ao selecionar slot da ferramenta", error);
        return false;
    }
}

function findHeldRepairTarget() {
    var item = Player.getHeldItem();
    if (item === null || TOOL_MATERIALS[item.getRegistryName()] === undefined || item.getMaxDamage() <= 0) return null;
    var remaining = item.getMaxDamage() - item.getDamage();
    return {
        slot: getHeldHotbarIndex(),
        name: ChatLib.removeFormatting(item.getName()),
        toolId: item.getRegistryName(),
        materialId: TOOL_MATERIALS[item.getRegistryName()],
        remaining: remaining
    };
}

function ensureRepairToolSelected() {
    try {
        var candidate = repairTarget;
        var inventory = Player.getInventory();
        var item = candidate === null || candidate === undefined ? null : inventory.getStackInSlot(candidate.slot);
        if (item === null || TOOL_MATERIALS[item.getRegistryName()] === undefined || item.getDamage() <= 0) {
            candidate = findRepairTarget();
            if (candidate === null) return false;
            repairTarget = candidate;
        }
        return selectHotbarSlot(candidate.slot);
    } catch (error) {
        reportError("restaurar espada para reparo", error);
        return false;
    }
}

function isUsableReserveTool(item) {
    return item !== null && TOOL_MATERIALS[item.getRegistryName()] !== undefined &&
        item.getMaxDamage() > 0 && (item.getMaxDamage() - item.getDamage()) >= MIN_RESERVE_DURABILITY &&
        (!SAME_TOOL_TYPE_ONLY || lockedRunToolId === null || item.getRegistryName() === lockedRunToolId) &&
        (preferredReplacementToolId === null || item.getRegistryName() === preferredReplacementToolId);
}

function findHotbarTool() {
    var inventory = Player.getInventory();
    if (inventory === null) return null;
    var best = null;
    for (var slot = 0; slot < Math.min(9, inventory.getSize()); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (isUsableReserveTool(item)) {
            var priority = TOOL_PRIORITY[item.getRegistryName()] || 0;
            var remaining = item.getMaxDamage() - item.getDamage();
            if (best === null || priority > best.priority || (priority === best.priority && remaining > best.remaining)) {
                best = { slot: slot, name: ChatLib.removeFormatting(item.getName()), priority: priority, remaining: remaining };
            }
        }
    }
    return best;
}

function findInventoryTool() {
    var inventory = Player.getInventory();
    if (inventory === null) return null;
    var best = null;
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (!isUsableReserveTool(item)) continue;
        var priority = TOOL_PRIORITY[item.getRegistryName()] || 0;
        var remaining = item.getMaxDamage() - item.getDamage();
        if (best === null || priority > best.priority || (priority === best.priority && remaining > best.remaining)) {
            best = { slot: slot, name: ChatLib.removeFormatting(item.getName()), priority: priority, remaining: remaining };
        }
    }
    return best;
}

function equipInventoryTool(tool) {
    if (tool === null) return false;
    try {
        if (tool.slot < 9) {
            return selectHotbarSlot(tool.slot);
        }
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        // mode 2 troca o slot do inventário pelo slot 0 da hotbar no ContainerPlayer 1.8.9.
        minecraft.field_71442_b.func_78753_a(player.field_71069_bz.field_75152_c, tool.slot, 0, 2, player);
        return selectHotbarSlot(0);
    } catch (error) {
        return false;
    }
}

function countMaterial(materialId) {
    var inventory = Player.getInventory();
    if (inventory === null) return 0;
    var count = 0;
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (isRepairMaterial(item, materialId)) count += item.getStackSize();
    }
    return count;
}

function prepareStorage() {
    var inventory = Player.getInventory();
    if (inventory === null) return false;

    var target = findRepairTarget();
    var keptMaterialSlot = -1;
    if (target !== null) {
        for (var i = 0; i < inventory.getSize(); i++) {
            var candidate = inventory.getStackInSlot(i);
            if (isRepairMaterial(candidate, target.materialId)) {
                keptMaterialSlot = i;
                break;
            }
        }
    }

    pendingStorageSlots = [];
    var occupied = 0;
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (item === null) continue;
        occupied++;

        // Inclui os nove slots da hotbar, salvo se o usuário optar por
        // reservá-los manualmente na configuração.
        if (slot < 9 && !DEPOSIT_HOTBAR) continue;
        // Itens de armazenamento puro têm prioridade: nunca são tratados como
        // ferramenta de combate, mesmo se outro ajuste futuro os cadastrar.
        if (STORAGE_ONLY_ITEMS.indexOf(item.getRegistryName()) !== -1) {
            pendingStorageSlots.push(slot);
            continue;
        }
        // Ex.: ossos ficam na mochila até completar 64 para a venda. Não vão
        // nem ao baú nem à placa enquanto a pilha estiver incompleta.
        if (keepUntilSellStackIsFull(item)) continue;
        // Nunca deposita ferramentas de combate: protege espada e machado atuais e reservas.
        if (TOOL_MATERIALS[item.getRegistryName()] !== undefined) continue;
        // Itens da lista preta permanecem no inventário e nunca entram na trap.
        if (isBlacklisted(item)) continue;
        // Mantem uma pilha do material da ferramenta que exige reparo; excessos vao ao bau.
        if (slot === keptMaterialSlot) continue;
        pendingStorageSlots.push(slot);
    }

    var freeSlots = inventory.getSize() - occupied;
    var storableItems = pendingStorageSlots.length;
    return freeSlots <= MIN_FREE_SLOTS || storableItems >= MIN_STORABLE_ITEMS;
}

function storageContainerSlot(container, playerSlot) {
    // O Container termina com 36 slots do jogador, independentemente do tamanho do baú.
    // Para baú duplo: 0-53 baú, 54-80 inventário e 81-89 hotbar.
    var chestSlots = container.getSize() - 36;
    return playerSlot < 9 ? chestSlots + 27 + playerSlot : chestSlots + (playerSlot - 9);
}

// ============================================================================
// VENDA OPCIONAL DE DROPS — usa as mesmas proteções da BolsoVender.
// ============================================================================
function sellDefinition(name) {
    var definition = SELLING_ITEMS[name];
    return definition && definition.item && definition.home ? definition : null;
}

function minimumSellStack(name) {
    var definition = sellDefinition(name);
    return definition === null ? 1 : Math.max(1, parseInt(definition.minimumStackSize, 10) || 1);
}

function keepUntilSellStackIsFull(item) {
    if (item === null) return false;
    for (var name in SELLING_ITEMS) {
        if (!SELLING_ITEMS.hasOwnProperty(name) || sellDefinition(name) === null) continue;
        if (String(SELLING_ITEMS[name].item) !== item.getRegistryName()) continue;
        var minimum = minimumSellStack(name);
        return minimum > 1 && item.getStackSize() < minimum;
    }
    return false;
}

function findSellableInventory() {
    if (!SELLING_ENABLED) return null;
    var inventory = Player.getInventory();
    if (inventory === null) return null;
    for (var name in SELLING_ITEMS) {
        if (!SELLING_ITEMS.hasOwnProperty(name) || sellDefinition(name) === null) continue;
        var itemId = String(SELLING_ITEMS[name].item);
        for (var slot = 0; slot < inventory.getSize(); slot++) {
            var stack = inventory.getStackInSlot(slot);
            if (stack !== null && stack.getRegistryName() === itemId && stack.getStackSize() >= minimumSellStack(name)) return name;
        }
    }
    return null;
}

function inventoryItemCount(itemId) {
    var inventory = Player.getInventory();
    if (inventory === null) return 0;
    var amount = 0;
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var stack = inventory.getStackInSlot(slot);
        if (stack !== null && stack.getRegistryName() === itemId) amount += stack.getStackSize();
    }
    return amount;
}

function hasSellAim(name) {
    var aim = sellingAims[name];
    return aim && aim.block && !isNaN(aim.block.x) && !isNaN(aim.block.y) && !isNaN(aim.block.z) && aim.block.side;
}

function captureSellAim(name) {
    try {
        if (sellDefinition(name) === null) {
            ChatLib.chat("&c[BolsoFarm] Venda inexistente no config.yml: " + name);
            return false;
        }
        var minecraft = Client.getMinecraft();
        var hit = minecraft.field_71476_x;
        if (hit === null || hit === undefined) hit = minecraft.field_71439_g.func_174822_a(5.0, 1.0);
        if (hit === null || hit === undefined || hit.func_178782_a() === null) {
            ChatLib.chat("&c[BolsoFarm] Mire diretamente na placa, a até 5 blocos.");
            return false;
        }
        var pos = hit.func_178782_a();
        sellingAims[name] = {
            block: {
                x: Number(pos.func_177958_n()),
                y: Number(pos.func_177956_o()),
                z: Number(pos.func_177952_p()),
                side: String(hit.field_178784_b)
            }
        };
        FileLib.write("BolsoFarm", "data/sell-aims.json", JSON.stringify(sellingAims));
        ChatLib.chat("&a[BolsoFarm] Placa de venda calibrada: " + name + ".");
        return true;
    } catch (error) {
        reportError("calibrar placa de venda", error);
        ChatLib.chat("&c[BolsoFarm] Não foi possível salvar a placa de venda.");
        return false;
    }
}

function attackSellSign(name) {
    try {
        if (!hasSellAim(name)) return false;
        var aim = sellingAims[name];
        var minecraft = Client.getMinecraft();
        var BlockPos = Java.type("net.minecraft.util.BlockPos");
        var EnumFacing = Java.type("net.minecraft.util.EnumFacing");
        var Vec3 = Java.type("net.minecraft.util.Vec3");
        var MovingObjectPosition = Java.type("net.minecraft.util.MovingObjectPosition");
        var position = new BlockPos(aim.block.x, aim.block.y, aim.block.z);
        var side = EnumFacing.valueOf(String(aim.block.side).toUpperCase());
        minecraft.field_71476_x = new MovingObjectPosition(new Vec3(aim.block.x + 0.5, aim.block.y + 0.5, aim.block.z + 0.5), side, position);
        minecraft.func_147116_af();
        return true;
    } catch (error) {
        reportError("atacar placa de venda", error);
        return false;
    }
}

function prepareCommandSaleProtection() {
    var inventory = Player.getInventory();
    pendingStorageSlots = [];
    if (inventory === null) return false;
    // Protege arcos (inclusive os da hotbar) antes do comando que vende tudo.
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (item !== null && SELLING_COMMAND_PROTECT_ITEMS.indexOf(item.getRegistryName()) !== -1) pendingStorageSlots.push(slot);
    }
    return pendingStorageSlots.length > 0;
}

function protectedCommandItemsInInventory() {
    var inventory = Player.getInventory();
    if (inventory === null) return 0;
    var count = 0;
    for (var slot = 0; slot < inventory.getSize(); slot++) {
        var item = inventory.getStackInSlot(slot);
        if (item !== null && SELLING_COMMAND_PROTECT_ITEMS.indexOf(item.getRegistryName()) !== -1) count += item.getStackSize();
    }
    return count;
}

function executeCommandSale(allowProtectedItems) {
    commandSaleAfterProtection = false;
    var protectedCount = protectedCommandItemsInInventory();
    if (allowProtectedItems !== true && protectedCount > 0) {
        appendDiagnostic("VENDA", "venda por comando cancelada: " + protectedCount + " item(ns) protegido(s) ainda no inventário.");
        ChatLib.chat("&c[BolsoFarm] Linha/arco ainda não foi guardado; /vender mobs cancelado para preservar os itens.");
        returnToFarm("&e[BolsoFarm] Depósito pendente; voltando ao farm sem vender itens protegidos.");
        return;
    }
    if (SELLING_COMMAND.length === 0) {
        returnToFarm("&c[BolsoFarm] Comando de venda vazio; voltando ao farm.");
        return;
    }
    stopCombat();
    setKey("key.sneak", false);
    ChatLib.say(SELLING_COMMAND);
    state = "SELL_COMMAND_WAIT";
    waitTicks = SELLING_COMMAND_WAIT_TICKS;
    appendDiagnostic("VENDA", "comando executado após proteger arcos: " + SELLING_COMMAND + ".");
    ChatLib.chat("&e[BolsoFarm] Arcos protegidos; executando &f" + SELLING_COMMAND + "&e.");
}

function beginCommandSelling() {
    if (sellingFailedThisCycle) return false;
    if (prepareCommandSaleProtection()) {
        commandSaleAfterProtection = true;
        ChatLib.chat("&e[BolsoFarm] Guardando " + pendingStorageSlots.length + " item(ns) protegido(s) antes da venda por comando.");
        return beginStorage(true, true);
    }
    executeCommandSale();
    return true;
}

function beginSelling() {
    if (SELLING_METHOD === "command") return beginCommandSelling();
    if (sellingFailedThisCycle) {
        appendDiagnostic("VENDA", "venda pulada neste ciclo após falha anterior; usando depósito.");
        return false;
    }
    var nextSale = findSellableInventory();
    if (nextSale === null) {
        appendDiagnostic("VENDA", "nenhum item configurado encontrado (linha/olho_aranha); usando depósito.");
        return false;
    }
    if (!hasSellAim(nextSale)) {
        appendDiagnostic("VENDA", "placa sem calibração para " + nextSale + "; usando depósito.");
        ChatLib.chat("&e[BolsoFarm] Venda de " + nextSale + " sem placa calibrada; guardando normalmente. Use /bolsofarm vender calibrar " + nextSale + ".");
        return false;
    }
    sellingCurrent = nextSale;
    sellingHitsLeft = 0;
    sellingCountBefore = inventoryItemCount(String(SELLING_ITEMS[nextSale].item));
    sellingNoProgressChecks = 0;
    stopCombat();
    setKey("key.sneak", false);
    if (SELLING_MENU_OFF_COMMAND.length > 0) ChatLib.say(SELLING_MENU_OFF_COMMAND);
    if (SELLING_HIDE_COMMAND.length > 0) ChatLib.say(SELLING_HIDE_COMMAND);
    goHome(SELLING_ITEMS[nextSale].home);
    scheduleTeleportJump();
    state = "SELL_WARP";
    waitTicks = SELLING_WARP_WAIT_TICKS;
    appendDiagnostic("VENDA", "iniciando venda de " + nextSale + "; quantidade=" + sellingCountBefore + ".");
    ChatLib.chat("&e[BolsoFarm] Vendendo " + nextSale + ".");
    return true;
}

function sellableItemsReadyForStorage() {
    var inventory = Player.getInventory();
    if (inventory === null) return 0;
    var total = 0;
    for (var name in SELLING_ITEMS) {
        if (!SELLING_ITEMS.hasOwnProperty(name) || sellDefinition(name) === null) continue;
        var itemId = String(SELLING_ITEMS[name].item);
        var minimum = minimumSellStack(name);
        for (var slot = 0; slot < inventory.getSize(); slot++) {
            var stack = inventory.getStackInSlot(slot);
            if (stack !== null && stack.getRegistryName() === itemId && stack.getStackSize() >= minimum) total += stack.getStackSize();
        }
    }
    return total;
}

function shouldSellDuringStorageTrip() {
    var total = sellableItemsReadyForStorage();
    if (total < SELLING_MIN_ITEMS_WHEN_STORING) {
        appendDiagnostic("VENDA", "depósito seguirá sem venda: " + total + "/" + SELLING_MIN_ITEMS_WHEN_STORING + " itens vendáveis.");
        return false;
    }
    return true;
}

function fallbackSellingToStorage(message) {
    sellingFailedThisCycle = true;
    sellingCurrent = null;
    setKey("key.sneak", false);
    appendDiagnostic("VENDA", "falhou; alternando para depósito.");
    ChatLib.chat(message);
    if (prepareStorage() && pendingStorageSlots.length > 0) {
        beginStorage(true);
    } else {
        returnToFarm(null);
    }
}

function findMaterialInOpenChest(container, materialId) {
    var chestSlots = container.getSize() - 36;
    for (var slot = 0; slot < chestSlots; slot++) {
        var item = container.getStackInSlot(slot);
        if (isRepairMaterial(item, materialId)) return slot;
    }
    return -1;
}

function findToolInOpenChest(container) {
    var chestSlots = container.getSize() - 36;
    var best = -1;
    var bestPriority = -1;
    for (var slot = 0; slot < chestSlots; slot++) {
        var item = container.getStackInSlot(slot);
        if (isUsableReserveTool(item)) {
            var priority = TOOL_PRIORITY[item.getRegistryName()] || 0;
            if (priority > bestPriority) {
                best = slot;
                bestPriority = priority;
            }
        }
    }
    return best;
}

function finishMaterialSearch() {
    // Primeiro conclui o fluxo local (trocar ferramenta, buscar material ou
    // parar com segurança). Só disableForMissingMaterial sinaliza o ciclo;
    // avisar antes deixava ações do Farm pendentes após a troca de fase.
    if (storageMode === "RESTOCK") handleMissingRepairMaterial(repairTarget);
    else disableForMissingMaterial("não há espada ou machado de reposição nos baús pesquisados.");
}

function materialSearchColumnLimit() {
    if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
        return Math.min(MAX_CHEST_COLUMNS, REPLACEMENT_SEARCH_MAX_COLUMNS);
    }
    return Math.min(MAX_CHEST_COLUMNS, MATERIAL_SEARCH_MAX_COLUMNS);
}

function searchAllRowsForCurrentRestock() {
    // A procura de espada é independente da de bloco de reparo: normalmente
    // percorre as cinco alturas da coluna antes de andar para a direita.
    return storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE" ? REPLACEMENT_SEARCH_ALL_ROWS : MATERIAL_SEARCH_ALL_ROWS;
}

function tryNextMaterialChest() {
    // Primeiro esgota as alturas da coluna quando o fluxo atual pede isso.
    if (searchAllRowsForCurrentRestock() && storageRow < 4) {
        storageRow++;
        setKey("key.inventory", true);
        state = "RESTOCK_CLOSE_FOR_ROW";
        waitTicks = 2;
        return;
    }

    // first_column: depois da primeira coluna, usa o fluxo de fallback/troca.
    if (MATERIAL_SEARCH_MODE !== "wall") {
        finishMaterialSearch();
        return;
    }

    if (storageColumn + 1 >= materialSearchColumnLimit()) {
        finishMaterialSearch();
        return;
    }

    storageRow = 0;
    setKey("key.inventory", true);
    state = "RESTOCK_CLOSE_FOR_MOVE";
    waitTicks = 2;
}

function fallbackNextMaterialChest() {
    closeCurrentScreen();
    // Espada e material possuem configurações verticais independentes.
    if (searchAllRowsForCurrentRestock() && storageRow < 4) {
        storageRow++;
        restockWarpWatchdogTicks = 0;
        state = "RESTOCK_FALLBACK_AIM";
        appendDiagnostic("RECUPERAÇÃO", "material não estava nesta altura; verificando linha " + (storageRow + 1) + " da mesma coluna.");
        return;
    }
    if (MATERIAL_SEARCH_MODE !== "wall") {
        appendDiagnostic("RECUPERAÇÃO", "item não estava na área configurada da primeira coluna; usando troca/fallback sem caminhar pela parede.");
        finishMaterialSearch();
        return;
    }
    if (storageColumn + 1 >= materialSearchColumnLimit()) {
        finishMaterialSearch();
        return;
    }
    storageColumn++;
    storageRow = 0;
    restockWarpWatchdogTicks = 0;
    setKey("key.sneak", true);
    setKey("key.right", true);
    state = "RESTOCK_FALLBACK_MOVE";
    appendDiagnostic("RECUPERAÇÃO", "item não estava nesta coluna; procurando coluna " + (storageColumn + 1) + ".");
}

function resetStorageProgressAfterFullSearch() {
    if (!RESET_STORAGE_PROGRESS_AFTER_FULL_SEARCH) return;
    lastStorageColumn = 0;
    lastStorageRow = 1;
    storageColumn = 0;
    storageRow = 1;
    resumeStorage = false;
    usingTemporaryStorageHome = false;
    temporaryStorageHomeReady = false;
    try {
        FileLib.write("BolsoFarm", storageProgressFile(), JSON.stringify({ column: 0, row: 1 }));
        FileLib.write("BolsoFarm", storageReturnFile(), JSON.stringify({ ready: false }));
    } catch (error) { reportError("resetar ponto após parede de depósito esgotada", error); }
    appendDiagnostic("DEPÓSITO", "parede de baús verificada até o fim; próximo depósito inicia no primeiro baú.");
    ChatLib.chat("&e[BolsoFarm] Parede de depósito verificada até o fim; próximo depósito começará no primeiro baú.");
}

function fallbackNextStorageChest() {
    closeCurrentScreen();
    if (storageColumn + 1 >= MAX_CHEST_COLUMNS) {
        resetStorageProgressAfterFullSearch();
        recoverStorageToFarm("&c[BolsoFarm] Limite de baús atingido; os itens restantes ficaram no inventário.");
        return;
    }
    storageColumn++;
    storageWarpWatchdogTicks = 0;
    setKey("key.sneak", true);
    setKey("key.right", true);
    state = "STORAGE_FALLBACK_MOVE";
    appendDiagnostic("RECUPERAÇÃO", "baú de depósito cheio; avançando para a coluna " + (storageColumn + 1) + ".");
}

function fallbackAdvanceStorageTarget() {
    closeCurrentScreen();
    // Termina as alturas da coluna atual antes de caminhar para a próxima.
    // A primeira coluna começa na linha 1 porque a linha 0 é de materiais.
    if (storageRow < 4) {
        storageRow++;
        storageWarpWatchdogTicks = 0;
        aimAtStorageRow();
        state = "STORAGE_FALLBACK_AIM";
        appendDiagnostic("RECUPERAÇÃO", "baú cheio; tentando a linha " + (storageRow + 1) + " da mesma coluna.");
        return;
    }
    storageRow = 0;
    fallbackNextStorageChest();
}

function beginStorage(skipSelling, usePreparedSlots) {
    if (usePreparedSlots !== true && (!prepareStorage() || pendingStorageSlots.length === 0)) return false;
    if (usePreparedSlots === true && pendingStorageSlots.length === 0) return false;
    // No modo periódico, ainda aproveita uma ida inevitável ao depósito para
    // vender os drops configurados. Fora disso, só o temporizador vende.
    if (!skipSelling && (!SELLING_ONLY_PERIODIC || SELLING_WHEN_STORING) && shouldSellDuringStorageTrip() && beginSelling()) return true;
    stopCombat();
    if (resumeStorage) {
        storageColumn = resumeColumn;
        storageRow = resumeRow;
        resumeStorage = false;
        ChatLib.chat("&e[BolsoFarm] Retomando depósito na coluna " + (storageColumn + 1) + ", linha " + (storageRow + 1) + ".");
    } else if (USE_TEMPORARY_STORAGE_HOME && REMEMBER_LAST_STORAGE_CHEST && temporaryStorageHomeReady) {
        storageColumn = lastStorageColumn;
        storageRow = lastStorageRow;
        ChatLib.chat("&e[BolsoFarm] Voltando direto ao último baú de depósito: coluna " + (storageColumn + 1) + ", linha " + (storageRow + 1) + ".");
    } else {
        storageColumn = 0;
        // A linha do topo da primeira coluna é exclusiva de materiais.
        storageRow = 1;
    }
    depositAttempt = null;
    chestOpenAttempts = 0;
    storageRealignAttempts = 0;
    storageMode = "DEPOSIT";
    ChatLib.chat("&e[BolsoFarm] Inventário cheio: guardando " + pendingStorageSlots.length + " pilhas em lote confirmado.");
    usingTemporaryStorageHome = USE_TEMPORARY_STORAGE_HOME && temporaryStorageHomeReady && REMEMBER_LAST_STORAGE_CHEST;
    goHome(usingTemporaryStorageHome ? HOME_STORAGE_TEMPORARY : HOME_STORAGE);
    scheduleTeleportJump();
    state = "STORAGE_WARP";
    waitTicks = 50;
    return true;
}

function finishStorageAfterDeposit(message) {
    if (commandSaleAfterProtection) {
        executeCommandSale();
        return;
    }
    returnToFarm(message);
}

function beginMaterialRestock(target) {
    repairTarget = target;
    // Shift-click de material não funciona sem espaço. Esvazia os drops antes
    // de ir ao baú de materiais; depois o fluxo reavalia o reparo normalmente.
    if (prepareStorage() && pendingStorageSlots.length > 0) {
        ChatLib.chat("&e[BolsoFarm] Inventário cheio; guardando drops antes de buscar material.");
        beginStorage();
        return;
    }
    storageColumn = 0;
    storageRow = 0;
    depositAttempt = null;
    chestOpenAttempts = 0;
    storageMode = "RESTOCK";
    stopCombat();
    ChatLib.chat("&e[BolsoFarm] Buscando " + materialName(target.materialId) + " no baú de materiais" +
        (MATERIAL_SEARCH_ALL_ROWS ? " (todas as fileiras)." : " (horizontal: primeira fileira)."));
    goHome(HOME_STORAGE);
    scheduleTeleportJump();
    state = "RESTOCK_WARP";
    waitTicks = 50;
}

function beginToolRestock() {
    repairTarget = null;
    storageColumn = 0;
    storageRow = 0;
    depositAttempt = null;
    chestOpenAttempts = 0;
    storageMode = "TOOL_RESTOCK";
    stopCombat();
    ChatLib.chat("&e[BolsoFarm] Sem espada/machado na mão; buscando uma ferramenta no baú de materiais.");
    goHome(HOME_STORAGE);
    scheduleTeleportJump();
    state = "RESTOCK_WARP";
    waitTicks = 50;
}

function beginToolReplacement(target) {
    repairTarget = target;
    Player.setHeldItemIndex(target.slot);
    storageColumn = 0;
    storageRow = 0;
    chestOpenAttempts = 0;
    storageMode = "REPLACE";
    stopCombat();
    ChatLib.chat("&e[BolsoFarm] Material de reparo indisponível; guardando a ferramenta gasta e buscando reserva.");
    goHome(HOME_STORAGE);
    scheduleTeleportJump();
    state = "RESTOCK_WARP";
    waitTicks = 50;
}

function openStorageChest() {
    chestOpenAttempts++;
    aimAtStorageRow();
    // Dá tempo ao ray trace do Minecraft atualizar o baú sob a nova mira.
    state = "STORAGE_AIM_WAIT";
    waitTicks = 3;
}

function clickAimedStorageChest() {
    // Alterna entre o clique nativo e a tecla real de "usar". Em alguns
    // servidores/clients o clique nativo não abre um baú apesar da mira estar
    // correta; a segunda tentativa então reproduz o botão direito normal.
    if (chestOpenAttempts % 2 === 0) {
        setKey("key.use", true);
        state = "STORAGE_OPEN_RELEASE";
        waitTicks = 2;
        return;
    }
    openAimedStorageChestDirect();
    state = "STORAGE_WAIT_CONTAINER";
    waitTicks = CHEST_OPEN_WAIT_TICKS;
}

function chestOpenRetryLimit() {
    return storageMode === "DEPOSIT" ? DEPOSIT_CHEST_OPEN_RETRIES : RESTOCK_CHEST_OPEN_RETRIES;
}

function tryStorageChestRealign() {
    // Só desloca o depósito. Busca de material/ferramenta deve permanecer no
    // alvo calibrado, sem caminhar para outro baú durante a recuperação.
    if (storageMode !== "DEPOSIT" || storageRealignAttempts >= STORAGE_REALIGN_ATTEMPTS) return false;
    storageRealignAttempts++;
    setKey("key.sneak", true);
    setKey("key.right", true);
    state = "STORAGE_REALIGN_RIGHT";
    waitTicks = 3;
    appendDiagnostic("RECUPERAÇÃO", "baú não abriu; realinhamento lateral " + storageRealignAttempts + "/" + STORAGE_REALIGN_ATTEMPTS + ".");
    ChatLib.chat("&e[BolsoFarm] Baú não abriu; reajustando posição e tentando novamente.");
    return true;
}

function advanceStorageTarget() {
    // Na primeira coluna, pula a linha 0 reservada a materiais. Nas demais, usa as 5 linhas.
    storageRow++;
    if (storageRow < 5) {
        // Fecha o baú atual antes de mirar e abrir o próximo nível da parede.
        closeCurrentScreen();
        state = "STORAGE_CLOSE_FOR_ROW";
        waitTicks = 2;
        return;
    }

    var columnLimit = storageMode === "REPLACE" ? Math.min(MAX_CHEST_COLUMNS, REPLACEMENT_SEARCH_MAX_COLUMNS) : MAX_CHEST_COLUMNS;
    if (storageColumn + 1 >= columnLimit) {
        if (storageMode === "REPLACE") {
            if (REPAIR_MAINTENANCE_MODE === "replace_then_repair") {
                ChatLib.chat("&e[BolsoFarm] Sem espada reserva; buscando material para reparar a atual.");
                beginMaterialRestock(repairTarget);
                return;
            }
            disableForMissingMaterial("não encontrei espada de reposição nas " + columnLimit + " primeiras colunas de baús.");
            return;
        }
        if (storageMode === "DEPOSIT") resetStorageProgressAfterFullSearch();
        recoverStorageToFarm("&c[BolsoFarm] Limite de baús atingido; tentando alternativa segura.");
        return;
    }

    storageRow = 0;
    // Fecha o baú atual e desloca uma coluna de baú duplo à direita (leste, olhando norte).
    closeCurrentScreen();
    state = "STORAGE_CLOSE_FOR_MOVE";
    waitTicks = 2;
}

function moveToNextChestColumn() {
    if (storageColumn >= MAX_CHEST_COLUMNS) {
        if (storageMode === "DEPOSIT") resetStorageProgressAfterFullSearch();
        recoverStorageToFarm("&c[BolsoFarm] Limite de baús atingido; tentando alternativa segura.");
        return;
    }
    // Agachado, mantém o jogador preso ao corredor de 1 bloco sem ultrapassar a linha.
    setKey("key.sneak", true);
    setKey("key.right", true);
    state = "STORAGE_MOVE_RIGHT";
    waitTicks = CHEST_STEP_TICKS;
}

function startRepair(target) {
    repairTarget = target;
    repairLastDamage = Player.getInventory().getStackInSlot(target.slot).getDamage();
    repairNoProgressCycles = 0;
    repairWarpAttempts = 0;
    repairWarpWatchdogTicks = 0;
    stopCombat();
    Player.setHeldItemIndex(target.slot);
    ChatLib.chat("&c[BolsoFarm] " + target.name + " com " + target.remaining + " de durabilidade. Indo reparar.");
    goHome(HOME_REPAIR);
    scheduleTeleportJump();
    state = "REPAIR_WARP";
    waitTicks = 60;
}

function beginFreshRepairCycle() {
    stopCombat();
    // Sempre reconstrói o alvo a partir da hotbar atual; nunca reutiliza slot antigo.
    var target = findRepairTarget();
    if (target === null) {
        var inventoryTool = findInventoryTool();
        if (inventoryTool !== null && equipInventoryTool(inventoryTool)) {
            waitTicks = 3;
            return;
        }
        beginToolRestock();
        return;
    }
    Player.setHeldItemIndex(target.slot);
    beginSelectedMaintenance(target);
}

// Decide a próxima rota usando apenas o inventário atual. Evita passar pela
// /home mob quando já se sabe que é necessário guardar, buscar ferramenta ou
// reparar a espada.
function routeFromCurrentInventory() {
    try {
        if (prepareStorage() && pendingStorageSlots.length > 0) {
            ChatLib.chat("&e[BolsoFarm] Inventário cheio; indo direto guardar os drops.");
            beginStorage();
            return;
        }

        var target = findHeldRepairTarget();
        if (target === null) {
            var availableTool = findHotbarTool();
            if (availableTool === null) availableTool = findInventoryTool();
            if (availableTool === null || !equipInventoryTool(availableTool)) {
                beginToolRestock();
                return;
            }
            target = findHeldRepairTarget();
        }
        if (runStartToolId === null && target !== null) runStartToolId = target.toolId;
        if (SAME_TOOL_TYPE_ONLY && lockedRunToolId === null && target !== null) {
            lockedRunToolId = target.toolId;
            ChatLib.chat("&e[BolsoFarm] Tipo travado nesta execução: &f" + lockedRunToolId + ".");
        }

        // A regra é sempre a mesma, inclusive ao ligar: só repara no limite.
        var shouldRepairNow = target !== null && target.remaining <= LOW_DURABILITY;
        initialStartupRepairPending = false;
        if (shouldRepairNow) {
            beginSelectedMaintenance(target);
            return;
        }

        returnToFarm(null);
    } catch (error) {
        reportError("planejar rota pelo inventário", error);
        returnToFarm(null);
    }
}

function beginRepairLikeStartup() {
    // A ferramenta já foi detectada abaixo do limite: ir antes à /home mob
    // desperdiça usos durante o warp. Decide e vai direto ao destino correto.
    stopCombat();
    pendingLowDurabilityRepair = false;
    beginFreshRepairCycle();
}

function returnToFarm(message) {
    if (message !== null) ChatLib.chat(message);
    stopCombat();
    goHome(HOME_FARM);
    scheduleTeleportJump();
    state = "FARM_WARP";
    waitTicks = 50;
}

function scheduleAutoRestart(message, kind) {
    if (state === "AUTO_RESTART") return;
    var allowed = AUTO_RESTART_ON_FAILURE &&
        (kind !== "repair" || RESTART_ON_REPAIR_NO_PROGRESS) &&
        (kind !== "timeout" || RESTART_ON_STATE_TIMEOUT);
    if (!allowed || (MAX_CONSECUTIVE_RESTARTS > 0 && consecutiveRestarts >= MAX_CONSECUTIVE_RESTARTS)) {
        enabled = false;
        state = "IDLE";
        stopCombat();
        saveRunState();
        ChatLib.chat("&c[BolsoFarm] Parada por falha: " + message + " (recuperação automática desativada/limitada na config.yml).");
        try { ChatLib.command("bolsociclo complete farm", true); } catch (ignoredCycle) { }
        return;
    }
    consecutiveRestarts++;
    ChatLib.chat("&e[BolsoFarm] Falha recuperável: " + message + " Reiniciando automaticamente.");
    stopCombat();
    closeCurrentScreen();
    repairTarget = null;
    state = "AUTO_RESTART";
    restartReason = message;
    restartTicks = AUTO_RESTART_DELAY_TICKS;
}

register("tick", function () {
    if (state !== "AUTO_RESTART") return;
    if (restartTicks > 0) {
        restartTicks--;
        return;
    }
    restartReason = null;
    state = "FARM_WARP";
    goHome(HOME_FARM);
    scheduleTeleportJump();
    waitTicks = 50;
});

function recoverStorageToFarm(message) {
    storageFailedThisCycle = true;
    commandSaleAfterProtection = false;
    // Emergência configurável: se o inventário já precisava ser guardado e o
    // baú falhou, vende tudo (inclusive arcos) em vez de repetir um depósito
    // impossível ou manter a macro parada com a mochila cheia.
    if (SELLING_ENABLED && SELLING_METHOD === "command" && SELLING_COMMAND_ON_STORAGE_FAILURE && pendingStorageSlots.length > 0) {
        appendDiagnostic("VENDA", "depósito indisponível; venda de emergência sem proteger arcos.");
        ChatLib.chat("&c[BolsoFarm] Depósito indisponível; inventário cheio. Executando /vender mobs (arcos inclusos).");
        executeCommandSale(true);
        return;
    }
    consecutiveStorageFailures++;

    // Falha local não significa parede esgotada. Mantém a última coluna salva
    // e só remove a home temporária para reposicionar pela home principal.
    // O reset para o primeiro baú ocorre apenas após a parede inteira.
    if (consecutiveStorageFailures >= STORAGE_FAILURES_BEFORE_FRESH_START) {
        consecutiveStorageFailures = 0;
        resumeStorage = true;
        usingTemporaryStorageHome = false;
        temporaryStorageHomeReady = false;
        try {
            FileLib.write("BolsoFarm", storageReturnFile(), JSON.stringify({ ready: false }));
        } catch (error) { reportError("limpar home temporária após falhas de depósito", error); }
        stats.recoveries++;
        appendDiagnostic("RECUPERAÇÃO", "depósito falhou " + STORAGE_FAILURES_BEFORE_FRESH_START + " vezes; reposicionando pelo último ponto salvo.");
        ChatLib.chat("&e[BolsoFarm] Depósito falhou " + STORAGE_FAILURES_BEFORE_FRESH_START + " vezes; reposicionando pelo último baú salvo.");
        scheduleAutoRestart("falhas repetidas no depósito; retomando último ponto salvo.", "storage");
        return;
    }
    // Se o baú não aceitar os itens, tenta vender somente os drops que têm
    // uma placa configurada. O restante continua protegido no inventário.
    if (!SELLING_ONLY_PERIODIC && !sellingFailedThisCycle && beginSelling()) {
        ChatLib.chat("&e[BolsoFarm] Depósito indisponível; tentando vender os drops configurados.");
        return;
    }
    resumeStorage = true;
    resumeColumn = storageColumn;
    resumeRow = storageRow;
    stats.recoveries++;
    returnToFarm(message);
}

function formatSessionDuration(milliseconds) {
    var totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    return (hours > 0 ? hours + "h " : "") + minutes + "m " + seconds + "s";
}

function showSessionStatistics() {
    var duration = sessionStartedAt > 0 ? formatSessionDuration(Date.now() - sessionStartedAt) : "sem sessão iniciada";
    var held = Player.getHeldItem();
    var toolInfo = "mão vazia";
    if (held !== null && held.getMaxDamage() > 0) {
        toolInfo = held.getRegistryName().replace("minecraft:", "") + " (&e" + (held.getMaxDamage() - held.getDamage()) + "&f/" + held.getMaxDamage() + " dur.)";
    }
    ChatLib.chat("&8&m--------------------------------");
    ChatLib.chat("&c&l[BolsoFarm] &fSessão encerrada &7(" + duration + ")");
    ChatLib.chat("&7Reparos: &a" + stats.repairs + " &7| Pilhas guardadas: &a" + stats.storedStacks + " &7| Itens vendidos: &a" + stats.soldItems);
    ChatLib.chat("&7Materiais retirados: &a" + stats.restocks + " &7| Espadas/ferramentas repostas: &a" + stats.toolRestocks);
    ChatLib.chat("&7Pilhas descartadas: &a" + stats.discardedStacks + " &7| Colunas de baú: &a" + stats.chestColumns + " &7| Recuperações: &e" + stats.recoveries);
    ChatLib.chat("&7Ferramenta final: &f" + toolInfo);
    ChatLib.chat("&8&m--------------------------------");
}

function toggleMacro() {
    enabled = !enabled;
    repairTarget = null;
    pendingStorageSlots = [];
    storageColumn = 0;
    storageRow = 0;
    depositAttempt = null;
    chestOpenAttempts = 0;
    if (!enabled) {
        lockedRunToolId = null;
        runStartToolId = null;
        preferredReplacementToolId = null;
        state = "IDLE";
        teleportJumpTicks = 0;
        teleportJumpReleaseTicks = 0;
        stopMovement();
        ChatLib.chat("&c[BolsoFarm] Desligada.");
        showSessionStatistics();
        return;
    }
    stats = { repairs: 0, storedStacks: 0, restocks: 0, toolRestocks: 0, chestColumns: 0, recoveries: 0, discardedStacks: 0, soldItems: 0 };
    sessionStartedAt = Date.now();
    lockedRunToolId = null;
    runStartToolId = null;
    preferredReplacementToolId = null;
    sellingFailedThisCycle = false;
    storageFailedThisCycle = false;
    sellingNoProgressChecks = 0;
    initialStartupRepairPending = true;
    pendingLowDurabilityRepair = false;
    ChatLib.chat("&a[BolsoFarm] Ligada. Verificando inventário.");
    routeFromCurrentInventory();
}

function toggleMacroWithPersist() {
    toggleMacro();
    autoResumeRequested = enabled;
    saveRunState();
}

function startMacroFromLastStorageChest() {
    if (enabled) {
        ChatLib.chat("&e[BolsoFarm] A macro já está ligada.");
        return;
    }
    if (!REMEMBER_LAST_STORAGE_CHEST) {
        ChatLib.chat("&e[BolsoFarm] Lembrança do último baú está desativada em storage.rememberLastChest.");
        return;
    }
    resumeStorage = true;
    resumeColumn = lastStorageColumn;
    resumeRow = lastStorageRow;
    toggleMacroWithPersist();
    ChatLib.chat("&a[BolsoFarm] Iniciada lembrando o último baú: coluna " + (resumeColumn + 1) + ", linha " + (resumeRow + 1) + ".");
}

function showRepairHelp() {
    ChatLib.chat("&6&m---------------- &eAutoReparar V2 &6&m----------------");
    ChatLib.chat("&e/bolsofarm start|stop&7: controla somente a farm manualmente.");
    ChatLib.chat("&e/bolsofarm start|stop|status|help|reset&7: comandos padronizados.");
    ChatLib.chat("&e/bolsofarm status&7: mostra estado, reparos, baús e recuperações.");
    ChatLib.chat("&e/bolsofarm inicio&7: esquece o último baú; próximo depósito começa no primeiro.");
    ChatLib.chat("&e/bolsofarm continuar&7: liga e usa o último baú de depósito salvo.");
    ChatLib.chat("&e/bolsofarm calibrar esqueleto|aranha <1-5>&7: calibra a parede indicada sem trocar perfil.");
    ChatLib.chat("&e/bolsofarm home esqueleto|aranha&7: salva o ponto da mobtrap indicado sem trocar perfil.");
    ChatLib.chat("&e/bolsofarm perfil esqueleto|aranha&7: troca o perfil manualmente (o ciclo faz isto sozinho). ");
    ChatLib.chat("&e/bolsofarm tutorial&7: mostra a montagem da trap de baús.");
    ChatLib.chat("&e/bolsofarm vender status&7: mostra a venda opcional de drops.");
    ChatLib.chat("&e/bolsofarm vender calibrar <nome>&7: salva a placa de venda configurada.");
    ChatLib.chat("&e/rep banir [id]&7: não guarda este drop; sem id usa o item na mão.");
    ChatLib.chat("&e/rep desbanir <id>&7 e &e/rep banidos&7: gerenciam a lista preta.");
    ChatLib.chat("&e/bolsofarm id&7: mostra o ID exato do item que você está segurando.");
    ChatLib.chat("&e/rep calibrar <1-5>&7: salva a mira (1 topo, 3 meio/home, 5 baixo).");
    ChatLib.chat("&7Manutenção: ajuste &erepair.maintenanceMode&7 no config.yml (reparar/trocar, só trocar, ou só reparar e parar).");
    ChatLib.chat("&6&m------------------------------------------------");
}

function showRepairTutorial() {
    ChatLib.chat("&6&m---------------- &eTutorial de baús &6&m----------------");
    ChatLib.chat("&7Monte uma parede voltada para &eNORTH&7, com &e5 baús de altura&7 e quantas colunas precisar.");
    ChatLib.chat("&7Deixe um corredor a &e1 bloco&7 da parede. O jogador anda agachado para a direita por ele.");
    ChatLib.chat("&7Use &e/sethome baus&7 alinhado ao baú do &emeio&7 da primeira coluna (duas alturas acima e duas abaixo). ");
    ChatLib.chat("&7De preferência, deixe materiais/ferramentas no topo: pedra lisa, blocos de ferro/ouro/diamante e reposição.");
    ChatLib.chat("&7Para materiais e ferramentas ela usa somente a linha do topo e segue para a próxima coluna quando necessário.");
    ChatLib.chat("&7Você pode alternar baú normal e baú com armadilha; a macro avança uma posição para a direita por vez.");
    ChatLib.chat("&7As quatro fileiras abaixo armazenam os drops. Quando encher, a macro avança para a próxima coluna.");
    ChatLib.chat("&7Para retomar depósitos sem reabrir os baús anteriores, use &e/rep continuar&7.");
    ChatLib.chat("&eCalibração correta: deixe a macro DESLIGADA e fique exatamente no bloco do &e/home baus&7.");
    ChatLib.chat("&7Sem andar, mire no centro de cada linha: &e1=topo, 2=segunda, 3=meio, 4=quarta, 5=baixo&7.");
    ChatLib.chat("&7Use &e/rep calibrar 1&7 até &e/rep calibrar 5&7, sempre de cima para baixo.");
    ChatLib.chat("&7A calibração é salva automaticamente e vale para todas as colunas da parede.");
    ChatLib.chat("&7Também configure &e/home mob&7 para a área de farm e &e/home reparar&7 para o local de reparo.");
    ChatLib.chat("&eComandos da farm: &e/bolsofarm home&7 salva a posição/mira atual e atualiza &f/home mob&7.");
    ChatLib.chat("&7Fique parado no ponto de ataque, mire nos mobs e só então execute o comando.");
    ChatLib.chat("&eComandos do reparo: &e/rep reparar&7 atualiza &f/home reparar&7.");
    ChatLib.chat("&7Deixe um bloco de ferro a até 4 blocos da home; ele é localizado automaticamente (chão, teto ou parede).");
    ChatLib.chat("&7Em &fconfig.yml&7: &erepair_then_replace&7, &ereplace_then_repair&7, &ereplace_only&7 ou &erepair_only_stop&7.");
    ChatLib.chat("&eConfiguração: edite &fconfig.yml&7 dentro da pasta &fBolsoFarm&7 e reinicie ou use /ct reload.");
    ChatLib.chat("&6&m------------------------------------------------");
}

register("command", function (action, value, third) {
    var rawAction = action === undefined ? "" : String(action).toLowerCase().trim();
    var actionParts = rawAction.length === 0 ? [] : rawAction.split(/\s+/);
    var option = actionParts.length === 0 ? "" : actionParts[0];
    var parameter = value === undefined ? actionParts[1] : value;
    if (option === "help" || option === "ajuda") {
        showRepairHelp();
        return;
    }
    if (option === "tutorial" || option === "baus") {
        showRepairTutorial();
        return;
    }
    if (option === "status") {
        ChatLib.command("repstatus", true);
        return;
    }
    if (option === "continuar" || option === "retomar" || option === "ultimo") {
        ChatLib.command("repcontinuar", true);
        return;
    }
    if (option === "inicio" || option === "recomecar" || option === "reiniciarbaus") {
        ChatLib.command("repinicio", true);
        return;
    }
    if (option === "log" || option === "erros") {
        ChatLib.command("replog", true);
        return;
    }
    if (option === "reparar" || option === "bloco") {
        ChatLib.command("repreparar", true);
        return;
    }
    if (option === "farm" || option === "mob" || option === "home") {
        ChatLib.command("repfarm", true);
        return;
    }
    if (option === "vender" || option === "venda") {
        var sellForwarded = "repvender";
        if (parameter !== undefined) sellForwarded += " " + parameter;
        if (third !== undefined) sellForwarded += " " + third;
        ChatLib.command(sellForwarded, true);
        return;
    }
    if (option === "id" || option === "itemid") {
        ChatLib.command("repitemid", true);
        return;
    }
    if (option === "reparar" || option === "bloco") {
        ChatLib.command("repreparar", true);
        return;
    }
    if (option === "banir" || option === "desbanir" || option === "banidos" || option === "calibrar") {
        var forwarded = option === "calibrar" ? "repcalibrar2" : "rep" + option;
        if (parameter !== undefined) forwarded += " " + parameter;
        ChatLib.command(forwarded, true);
        return;
    }
    toggleMacroWithPersist();
}).setName("rep");

register("command", function () {
    showRepairHelp();
}).setName("rephelp");

// Comando padrão organizado. /rep e seus atalhos antigos permanecem compatíveis.
register("command", function (action, value, third) {
    var normalizedAction = String(action === undefined ? "" : action).toLowerCase().trim();
    if (normalizedAction === "calibracoes" || normalizedAction === "calibrações") { showProfileCalibrations(); return; }
    if ((normalizedAction === "home" || normalizedAction === "mob" || normalizedAction === "farm") && value !== undefined) { saveNamedFarmAim(value); return; }
    if (normalizedAction === "calibrar" && value !== undefined && third !== undefined) {
        calibrateNamedProfile(value, third);
        return;
    }
    if (normalizedAction === "perfil" || normalizedAction === "profile") {
        var requestedProfile = String(value === undefined ? "" : value).toLowerCase().trim();
        if (requestedProfile === "" || MACRO_CONFIG.profiles === undefined || MACRO_CONFIG.profiles[requestedProfile] === undefined) {
            var availableProfiles = [];
            if (MACRO_CONFIG.profiles !== undefined) for (var profileName in MACRO_CONFIG.profiles) if (MACRO_CONFIG.profiles.hasOwnProperty(profileName)) availableProfiles.push(profileName);
            ChatLib.chat("&c[BolsoFarm] Perfil inválido. Disponíveis: &f" + availableProfiles.join(", "));
            return;
        }
        if (enabled) { ChatLib.chat("&c[BolsoFarm] Pare a macro antes de trocar de perfil."); return; }
        FileLib.write("BolsoFarm", "data/profile.json", JSON.stringify({ name: requestedProfile }));
        ChatLib.chat("&a[BolsoFarm] Perfil &f" + requestedProfile + " &asalvo; recarregando configurações.");
        ChatLib.command("ct reload", true);
        return;
    }
    if (normalizedAction === "start" || normalizedAction === "iniciar" || normalizedAction === "ligar") {
        if (enabled) ChatLib.chat("&e[BolsoFarm] Já está ligada."); else toggleMacroWithPersist();
        return;
    }
    if (normalizedAction === "stop" || normalizedAction === "parar" || normalizedAction === "desligar") {
        if (enabled) toggleMacroWithPersist(); else ChatLib.chat("&e[BolsoFarm] Já está desligada.");
        return;
    }
    if (normalizedAction === "reset" || normalizedAction === "reiniciar") { ChatLib.command("repinicio", true); return; }
    if (normalizedAction === "status") { ChatLib.command("repstatus", true); return; }
    if (normalizedAction === "help" || normalizedAction === "ajuda") { ChatLib.command("rephelp", true); return; }
    var command = "rep";
    if (action !== undefined && String(action).trim() !== "") command += " " + String(action);
    if (value !== undefined && String(value).trim() !== "") command += " " + String(value);
    if (third !== undefined && String(third).trim() !== "") command += " " + String(third);
    ChatLib.command(command, true);
}).setName("bolsofarm");

register("command", function (action, name) {
    var option = String(action || "status").toLowerCase();
    if (option === "status") {
        var configured = 0;
        var calibrated = 0;
        for (var saleName in SELLING_ITEMS) {
            if (!SELLING_ITEMS.hasOwnProperty(saleName) || sellDefinition(saleName) === null) continue;
            configured++;
            if (hasSellAim(saleName)) calibrated++;
        }
        ChatLib.chat("&b[BolsoFarm] Venda de drops: " + (SELLING_ENABLED ? "&aATIVADA" : "&cDESATIVADA") + "&7 | placas: &f" + calibrated + "/" + configured);
        return;
    }
    if (option === "calibrar") {
        if (name === undefined || String(name).trim() === "") {
            ChatLib.chat("&cUse /bolsofarm vender calibrar <nome>.");
            return;
        }
        captureSellAim(String(name).toLowerCase());
        return;
    }
    ChatLib.chat("&eUse /bolsofarm vender status ou /bolsofarm vender calibrar <nome>.");
}).setName("repvender");

register("command", function () {
    showRepairHelp();
}).setName("bolsofarmhelp");

register("command", function () {
    try {
        var item = Player.getHeldItem();
        if (item === null) {
            ChatLib.chat("&e[BolsoFarm] Segure o item e use /rep id novamente.");
            return;
        }
        ChatLib.chat("&b[BolsoFarm] ID: &f" + item.getRegistryName() + " &7| nome: &f" + ChatLib.removeFormatting(item.getName()));
    } catch (error) { reportError("mostrar ID do item", error); }
}).setName("repitemid");

// Rota independente para a calibração: usa a pasta física do módulo.
register("command", function (rowText) {
    var rowNumber = parseInt(rowText);
    if (isNaN(rowNumber) || rowNumber < 1 || rowNumber > 5) {
        ChatLib.chat("&c[BolsoFarm] Use /rep calibrar <1-5>: 1=topo, 3=meio e 5=baixo.");
        return;
    }

    try {
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) throw "jogador indisponível";
        var row = rowNumber - 1;
        CHEST_ROW_PITCH[row] = player.field_70125_A;
        var hit = Client.getMinecraft().field_71476_x;
        if (hit === null) {
            throw "mire diretamente no baú antes de calibrar";
        }
        var hitText = String(hit);
        var coordinates = hitText.match(/blockpos=BlockPos\{x=(-?\d+), y=(-?\d+), z=(-?\d+)\}/);
        if (coordinates === null) {
            throw "mire em qualquer parte do baú antes de calibrar";
        }
        CHEST_ROW_TARGETS[row] = {
            x: parseInt(coordinates[1]),
            y: parseInt(coordinates[2]),
            z: parseInt(coordinates[3]),
            // Parede MKB voltada ao norte: o corredor/interação fica no lado sul.
            side: "SOUTH"
        };
        FileLib.write("BolsoFarm", profileCalibrationFile(), JSON.stringify({ pitch: CHEST_ROW_PITCH, targets: CHEST_ROW_TARGETS }));
        ChatLib.chat("&a[BolsoFarm] Fileira " + rowNumber + " calibrada: baú e mira salvos.");
    } catch (error) {
        ChatLib.chat("&c[BolsoFarm] Não foi possível salvar: " + error);
    }
}).setName("repcalibrar2");

register("command", function () {
    try {
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) throw "jogador indisponível";
        var setRepairHome = setHomeCommandFromHomeCommand(HOME_REPAIR);
        if (setRepairHome === null) {
            ChatLib.chat("&c[BolsoFarm] homes.repair deve estar no formato /home nome para usar /rep reparar.");
            return;
        }
        setHomeWithConfirmation(setRepairHome);
        ChatLib.chat("&a[BolsoFarm] " + HOME_REPAIR + " atualizado. O bloco de ferro será localizado automaticamente.");
    } catch (error) {
        ChatLib.chat("&c[BolsoFarm] Não foi possível atualizar /home reparar: " + error);
    }
}).setName("repreparar");

register("command", function () {
    try {
        var player = Client.getMinecraft().field_71439_g;
        if (player === null) throw "jogador indisponível";
        farmAim = {
            yaw: player.field_70177_z,
            pitch: player.field_70125_A,
            target: { x: player.field_70165_t, y: player.field_70163_u, z: player.field_70161_v }
        };
        FileLib.write("BolsoFarm", farmAimFileForProfile(ACTIVE_PROFILE_NAME), JSON.stringify(farmAim));
        var setFarmHome = setHomeCommandFromHomeCommand(HOME_FARM);
        if (setFarmHome === null) {
            ChatLib.chat("&c[BolsoFarm] homes.farm deve estar no formato /home nome para usar /bolsofarm home.");
            return;
        }
        setHomeWithConfirmation(setFarmHome);
        ChatLib.chat("&a[BolsoFarm] Mira da farm salva e " + HOME_FARM + " atualizado.");
    } catch (error) {
        ChatLib.chat("&c[BolsoFarm] Não foi possível salvar a mira da farm: " + error);
    }
}).setName("repfarm");

// A tecla F pertence ao BolsoCiclo. BolsoFarm é ligado somente pelos comandos
// diretos ou pelo coordenador, evitando duas macros simultâneas.

var resumeDelayTicks = 0;
// Enquanto a placa está sendo acionada, repete o ataque dirigido exatamente
// como a BolsoVender. Shift é mantido solto para nunca clicar agachado.
register("tick", function () {
    if (!enabled || sellingCurrent === null) return;
    // Inclui SELL_READY: assim que o warp estabiliza, a placa recebe o primeiro
    // clique sem esperar outro ciclo da máquina de estados.
    if (state !== "SELL_READY" && state !== "SELL_HIT" && state !== "SELL_HOLD") return;
    setKey("key.sneak", false);
    attackSellSign(sellingCurrent);
});

// Alguns servidores deixam o callback principal aguardando após /home. A venda
// possui watchdog próprio para não ficar parada na placa indefinidamente.
register("tick", function () {
    if (!enabled || sellingCurrent === null) {
        sellingWarpWatchdogTicks = 0;
        sellingReadyWatchdogTicks = 0;
        return;
    }
    if (state === "SELL_WARP") {
        sellingWarpWatchdogTicks++;
        sellingReadyWatchdogTicks = 0;
        if (sellingWarpWatchdogTicks >= 100) {
            sellingWarpWatchdogTicks = 0;
            state = "SELL_READY";
            waitTicks = 0;
            ChatLib.chat("&e[BolsoFarm] Warp de venda confirmado; acionando a placa.");
        }
        return;
    }
    sellingWarpWatchdogTicks = 0;
    if (state !== "SELL_READY") {
        sellingReadyWatchdogTicks = 0;
        return;
    }
    sellingReadyWatchdogTicks++;
    if (sellingReadyWatchdogTicks < 40) return;
    sellingReadyWatchdogTicks = 0;
    var countNow = inventoryItemCount(String(SELLING_ITEMS[sellingCurrent].item));
    if (countNow < sellingCountBefore) {
        stats.soldItems += sellingCountBefore - countNow;
        sellingCountBefore = countNow;
        sellingNoProgressChecks = 0;
        var nextConfiguredSale = findSellableInventory();
        if (nextConfiguredSale === null) {
            sellingCurrent = null;
            sellingFailedThisCycle = false;
            storageFailedThisCycle = false;
            appendDiagnostic("VENDA", "todos os itens configurados foram vendidos; retornando à farm.");
            returnToFarm("&a[BolsoFarm] Venda concluída; voltando ao farm.");
            return;
        }
        if (nextConfiguredSale !== sellingCurrent) {
            appendDiagnostic("VENDA", "próximo item detectado: " + nextConfiguredSale + ".");
            sellingCurrent = null;
            beginSelling();
        }
        return;
    }
    sellingNoProgressChecks++;
    if (sellingNoProgressChecks >= SELLING_MAX_NO_PROGRESS) {
        fallbackSellingToStorage("&e[BolsoFarm] A placa não vendeu após " + SELLING_MAX_NO_PROGRESS + " tentativas; guardando no baú.");
    }
});

// Viagem opcional de venda por intervalo. Com periodicCheckMinutes: 0 ela fica
// desligada; a venda ocorre somente junto da ida necessária ao depósito.
register("tick", function () {
    if (!enabled || !SELLING_ENABLED || !SELLING_PERIODIC_ENABLED || state !== "FARMING" || sellingCurrent !== null) {
        periodicSaleTicks = 0;
        return;
    }
    periodicSaleTicks++;
    if (periodicSaleTicks < SELLING_PERIODIC_CHECK_TICKS) return;
    periodicSaleTicks = 0;
    if (findSellableInventory() === null) return;
    appendDiagnostic("VENDA", "checagem periódica encontrou itens vendáveis; iniciando venda.");
    beginSelling();
});

register("tick", function () {
    if (!enabled || state !== "FARMING" || !AUTO_ATTACK_FARM) {
        autoClickTicks = 0;
        return;
    }
    try {
        if (Client.getMinecraft().field_71462_r !== null) return;
        if (LOCK_FARM_AIM && !TARGET_NEAREST_MOB) aimAtFarm();
        var safeHeldItem = Player.getHeldItem();
        if (safeHeldItem === null || TOOL_MATERIALS[safeHeldItem.getRegistryName()] === undefined) {
            stopCombat();
            // Se o jogador trocou de slot, volta primeiro à espada escolhida para
            // a farm. Não consulta baús nem abandona o autoclick por esse motivo.
            var remembered = farmToolSlot >= 0 ? Player.getInventory().getStackInSlot(farmToolSlot) : null;
            if (remembered !== null && TOOL_MATERIALS[remembered.getRegistryName()] !== undefined &&
                remembered.getDamage() < remembered.getMaxDamage() && selectHotbarSlot(farmToolSlot)) {
                ChatLib.chat("&e[BolsoFarm] Voltando para a ferramenta da farm.");
                return;
            }
            var inventoryTool = findInventoryTool();
            if (inventoryTool !== null && equipInventoryTool(inventoryTool)) {
                farmToolSlot = getHeldHotbarIndex();
                ChatLib.chat("&e[BolsoFarm] Ferramenta do inventário equipada: " + inventoryTool.name + ".");
                return;
            }
            ChatLib.chat("&e[BolsoFarm] Sem ferramenta na mão; buscando reposição.");
            beginToolRestock();
            return;
        }

        var safeRemaining = safeHeldItem.getMaxDamage() - safeHeldItem.getDamage();
        if (safeHeldItem.getDamage() >= safeHeldItem.getMaxDamage()) {
            stopCombat();
            ChatLib.chat("&e[BolsoFarm] Ferramenta quebrada; buscando reposição.");
            beginToolRestock();
            return;
        }
        if (safeRemaining <= LOW_DURABILITY) {
            stopCombat();
            var safeTarget = {
                // O wrapper Player do CT 1.8.9 nem sempre expõe este método.
                // Usa o índice nativo com fallback para não ignorar o reparo.
                slot: getHeldHotbarIndex(),
                name: ChatLib.removeFormatting(safeHeldItem.getName()),
                toolId: safeHeldItem.getRegistryName(),
                materialId: TOOL_MATERIALS[safeHeldItem.getRegistryName()],
                remaining: safeRemaining
            };
            beginRepairLikeStartup();
            return;
        }
        autoClickTicks++;
        if (autoClickTicks >= AUTO_CLICK_INTERVAL_TICKS) {
            autoClickTicks = 0;
            if (!TARGET_NEAREST_MOB || !attackNearestFarmMob()) Client.getMinecraft().func_147116_af();
        }
    } catch (error) { reportError("autoclick/verificação de durabilidade", error); }
});

// Rota independente para servidores que mantêm o worldLoad ativo após /home.
// Ela impede que REPAIR_WARP fique preso mesmo que a espera global seja rearmada.
register("tick", function () {
    if (!enabled || state !== "REPAIR_WARP") {
        repairWarpWatchdogTicks = 0;
        return;
    }
    repairWarpWatchdogTicks++;
    if (repairWarpWatchdogTicks < 100) return;
    repairWarpWatchdogTicks = 0;
    waitTicks = 5;
    state = "REPAIR_AIM_WAIT";
    ChatLib.chat("&e[BolsoFarm] Warp confirmado pelo modo de segurança; iniciando reparo.");
});

// Alguns clientes/servidores deixam um callback de tick antigo preso após um
// /home. Este watchdog é independente da máquina principal: se FARM_WARP não
// consumir a espera, ele conclui a entrada na farm em vez de abandonar o
// autoclick para sempre.
register("tick", function () {
    if (!enabled || state !== "FARM_WARP") {
        farmWarpWatchdogTicks = 0;
        return;
    }
    farmWarpWatchdogTicks++;
    if (farmWarpWatchdogTicks < 100) return;
    farmWarpWatchdogTicks = 0;
    try {
        var watchdogTarget = findRepairTarget();
        var mustRepair = watchdogTarget !== null && watchdogTarget.remaining <= LOW_DURABILITY &&
            (pendingLowDurabilityRepair || initialStartupRepairPending);
        initialStartupRepairPending = false;
        pendingLowDurabilityRepair = false;
        if (mustRepair) {
            appendDiagnostic("RECUPERAÇÃO", "FARM_WARP travado; iniciando reparo de segurança.");
            beginFreshRepairCycle();
            return;
        }
        var watchdogTool = findHeldRepairTarget();
        if (watchdogTool === null || watchdogTool.remaining <= 0) {
            watchdogTool = findHotbarTool();
            if (watchdogTool !== null) selectHotbarSlot(watchdogTool.slot);
        }
        farmToolSlot = watchdogTool === null ? -1 : watchdogTool.slot;
        state = "FARMING";
        waitTicks = 0;
        appendDiagnostic("RECUPERAÇÃO", "FARM_WARP travado; farm retomada pelo watchdog.");
        ChatLib.chat("&e[BolsoFarm] Warp demorou; farm retomada pelo modo de segurança.");
    } catch (error) { reportError("recuperar FARM_WARP travado", error); }
});

register("worldLoad", function () {
    if (cycleControlsStartup() || !AUTO_RESUME_AFTER_RELOG || !autoResumeRequested || enabled || startupResumeQueued) return;
    startupResumeQueued = true;
    resumeDelayTicks = 60;
});

register("tick", function () {
    if (!startupResumeQueued) return;
    if (resumeDelayTicks > 0) {
        resumeDelayTicks--;
        return;
    }

    // Espera o jogador existir antes de usar /home, inclusive em conexões lentas.
    if (Client.getMinecraft().field_71439_g === null) {
        resumeDelayTicks = 20;
        return;
    }

    startupResumeQueued = false;
    enabled = true;
    state = "IDLE";
    ChatLib.chat("&a[BolsoFarm] Retomando automaticamente após o relog.");
    routeFromCurrentInventory();
});

register("command", function () {
    movementEnabled = !movementEnabled;
    if (!movementEnabled) stopMovement(); else resumeMovement();
    ChatLib.chat("&e[BolsoFarm] Movimento contínuo " + (movementEnabled ? "&aLIGADO" : "&cDESLIGADO") + "&e.");
}).setName("repav2mover");

register("command", function () {
    ChatLib.chat("&b[BolsoFarm] &fEstado: &e" + state + " &7| espera: &e" + waitTicks + " &7| reparos: &a" + stats.repairs + " &7| guardados: &a" + stats.storedStacks + " &7| materiais: &a" + stats.restocks + " &7| reservas: &a" + stats.toolRestocks + " &7| recuperações: &a" + stats.recoveries);
}).setName("repstatus");

register("command", function () {
    startMacroFromLastStorageChest();
}).setName("repcontinuar");

register("command", function () {
    if (enabled) {
        ChatLib.chat("&e[BolsoFarm] Desligue a macro antes de zerar o ponto dos baús.");
        return;
    }
    resumeStorage = false;
    resumeColumn = 0;
    resumeRow = 1;
    lastStorageColumn = 0;
    lastStorageRow = 1;
    temporaryStorageHomeReady = false;
    temporaryStorageHomeCommand = null;
    temporaryStorageHomeTicks = 0;
    try {
        FileLib.write("BolsoFarm", storageProgressFile(), JSON.stringify({ column: 0, row: 1 }));
        FileLib.write("BolsoFarm", storageReturnFile(), JSON.stringify({ ready: false }));
        ChatLib.chat("&a[BolsoFarm] Ponto e home temporária dos baús zerados. O próximo depósito começará em /home baus, coluna 1, linha 2.");
    } catch (error) {
        ChatLib.chat("&c[BolsoFarm] Não foi possível zerar o ponto dos baús: " + error);
    }
}).setName("repinicio");

register("command", function () {
    try {
        var log = FileLib.read("BolsoFarm", ERROR_LOG_FILE) || "";
        if (log.length === 0) {
            ChatLib.chat("&a[BolsoFarm] Nenhum erro registrado. O arquivo fica em data/error-log.txt.");
            return;
        }
        var entries = log.replace(/\r/g, "").split("\n");
        var shown = 0;
        ChatLib.chat("&4&l[BolsoFarm] Últimos erros (arquivo completo: data/error-log.txt):");
        for (var i = entries.length - 1; i >= 0 && shown < 5; i--) {
            if (entries[i].length === 0) continue;
            ChatLib.chat("&c" + entries[i]);
            shown++;
        }
    } catch (error) { reportError("ler arquivo de erros", error); }
}).setName("replog");

register("command", function (itemId) {
    try {
        var id = itemId;
        if (id === undefined || id === "") {
            var held = Player.getHeldItem();
            if (held === null) {
                ChatLib.chat("&cSegure o item ou informe o ID. Ex.: /repav2banir minecraft:rotten_flesh");
                return;
            }
            id = held.getRegistryName();
        }
        if (DROP_BLACKLIST.indexOf(id) === -1) DROP_BLACKLIST.push(id);
        saveBlacklist();
        ChatLib.chat("&a[BolsoFarm] Não guardar: &f" + id);
    } catch (error) { reportError("adicionar item à lista preta", error); ChatLib.chat("&c[BolsoFarm] Não foi possível adicionar o item à lista preta."); }
}).setName("repbanir");

register("command", function (itemId) {
    var index = DROP_BLACKLIST.indexOf(itemId);
    if (index === -1) {
        ChatLib.chat("&e[BolsoFarm] Esse ID não está na lista preta.");
        return;
    }
    DROP_BLACKLIST.splice(index, 1);
    saveBlacklist();
    ChatLib.chat("&a[BolsoFarm] Permitido guardar: &f" + itemId);
}).setName("repdesbanir");

register("command", function () {
    ChatLib.chat("&b[BolsoFarm] Lista preta: &f" + (DROP_BLACKLIST.length === 0 ? "vazia" : DROP_BLACKLIST.join(", ")));
}).setName("repbanidos");

register("command", function (row) {
    var index = parseInt(row);
    if (isNaN(index) || index < 0 || index > 4) {
        ChatLib.chat("&cUse /repav2calibrar <0-4>: 0=topo, 2=meio, 4=baixo.");
        return;
    }
    try {
        var player = Client.getMinecraft().field_71439_g;
        CHEST_ROW_PITCH[index] = player.field_70125_A;
        FileLib.write("BolsoFarm", profileCalibrationFile(), JSON.stringify({ pitch: CHEST_ROW_PITCH, targets: CHEST_ROW_TARGETS }));
        ChatLib.chat("&a[BolsoFarm] Mira da linha " + index + " salva: " + CHEST_ROW_PITCH[index].toFixed(1));
    } catch (error) {
        ChatLib.chat("&c[BolsoFarm] Não foi possível salvar a calibração.");
    }
}).setName("repcalibrar");

register("worldLoad", function () {
    if (!enabled) return;
    // Não altera a espera do reparo: alguns servidores disparam worldLoad repetidamente.
    if (state === "REPAIR_WARP") {
        return;
    }
    if (state !== "REPAIR_AIM_WAIT") {
        waitTicks = Math.max(waitTicks, 20);
    }
    // Mudança inesperada de mundo durante o farm: volta ao ponto conhecido e reinicia seguro.
    if (state === "FARMING") returnToFarm("&e[BolsoFarm] Mudança de mundo inesperada; reiniciando no farm.");
});

// Se o callback principal ficar congelado depois do clique, não deixa a
// macro eternamente em STORAGE_WAIT_CONTAINER. Faz a mesma retentativa segura
// do fluxo normal e, ao esgotá-la, volta/reinicia conforme o modo atual.
register("tick", function () {
    if (!enabled || state !== "STORAGE_WAIT_CONTAINER") {
        storageWaitWatchdogTicks = 0;
        return;
    }
    storageWaitWatchdogTicks++;
    if (storageWaitWatchdogTicks < Math.max(40, CHEST_OPEN_WAIT_TICKS + 20)) return;
    storageWaitWatchdogTicks = 0;
    try {
        var watchdogContainer = Player.getContainer();
        if (watchdogContainer !== null && watchdogContainer.getSize() >= 63) return;
        if (chestOpenAttempts < chestOpenRetryLimit()) {
            appendDiagnostic("RECUPERAÇÃO", "STORAGE_WAIT_CONTAINER travado; tentando abrir o baú novamente.");
            ChatLib.chat("&e[BolsoFarm] Baú demorou a abrir; tentando novamente.");
            openStorageChest();
            return;
        }
        if (tryStorageChestRealign()) return;
        appendDiagnostic("RECUPERAÇÃO", "STORAGE_WAIT_CONTAINER sem baú após as tentativas; saindo em segurança.");
        if (storageMode === "RESTOCK") handleMissingRepairMaterial(repairTarget);
        else if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") scheduleAutoRestart("baú de materiais não abriu; tentando novamente pela /home mob.", "timeout");
        else if (storageMode === "DEPOSIT" && usingTemporaryStorageHome) retryStorageFromMainHome("&e[BolsoFarm] Home temporária não abriu um baú; voltando pela /home baus principal.");
        else recoverStorageToFarm("&c[BolsoFarm] Baú não abriu; voltando ao farm em segurança.");
    } catch (error) { reportError("watchdog de abertura de baú", error); }
});

// O servidor pode entregar a espada ao jogador e, ainda assim, deixar a GUI
// do baú sem resposta. Depois de uma pequena margem para o fluxo normal,
// confirma a ferramenta na hotbar e volta ao farm em vez de ficar aguardando.
register("tick", function () {
    var isToolRestock = storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE";
    var isWaitingForTool = state === "STORAGE_WAIT_CONTAINER" || state === "RESTOCK_CHECK";
    if (!enabled || !isToolRestock || !isWaitingForTool) {
        toolRestockConfirmWatchdogTicks = 0;
        return;
    }
    toolRestockConfirmWatchdogTicks++;
    if (toolRestockConfirmWatchdogTicks < 30) return;
    toolRestockConfirmWatchdogTicks = 0;
    try {
        var confirmedTool = findHotbarTool();
        if (confirmedTool === null || !selectHotbarSlot(confirmedTool.slot)) return;
        closeCurrentScreen();
        farmToolSlot = confirmedTool.slot;
        preferredReplacementToolId = null;
        storageMode = "DEPOSIT";
        stats.toolRestocks++;
        appendDiagnostic("RECUPERAÇÃO", "espada confirmada na hotbar; saindo da confirmação de baú travada.");
        returnToFarm("&a[BolsoFarm] Espada confirmada; voltando ao farm.");
    } catch (error) { reportError("confirmar espada retirada do baú", error); }
});

register("tick", function () {
    if (statusCooldown > 0) statusCooldown--;
    if (discardCooldownTicks > 0) discardCooldownTicks--;
    if (!enabled) return;

    if (state === observedState) stateStallTicks++; else {
        observedState = state;
        stateStallTicks = 0;
    }

    // Estados de transição não podem ficar parados por mais de 30 segundos.
    if (state !== "FARMING" && state !== "PAUSED" && state !== "IDLE" && state !== "AUTO_RESTART" && stateStallTicks >= 600) {
        scheduleAutoRestart("estado travado em " + state + ".", "timeout");
        return;
    }

    if (waitTicks > 0) {
        waitTicks--;
        return;
    }

    if (state === "FARMING") {
        try {
            if (Client.getMinecraft().field_71462_r !== null) {
                stopCombat();
                state = "PAUSED";
                pauseNoticeShown = true;
                ChatLib.chat("&e[BolsoFarm] Pausada: feche chat/menu para continuar.");
                return;
            }
        } catch (error) { reportError("verificar tela da farm", error); }
    }

    if (state === "PAUSED") {
        try {
            if (Client.getMinecraft().field_71462_r !== null) return;
        } catch (error) { reportError("retomar farm após pausa", error); return; }
        pauseNoticeShown = false;
        state = "FARMING";
        // O cliente pode devolver mão vazia logo após fechar uma GUI. Espera a
        // sincronização para não iniciar reposição de espada sem necessidade.
        waitTicks = 10;
        consecutiveRestarts = 0;
        ChatLib.chat("&a[BolsoFarm] Retomada.");
        resumeMovement();
        return;
    }

    if (state === "SELL_WARP") {
        // O pulo é agendado em beginSelling(), como nos demais /home da macro.
        setKey("key.sneak", false);
        state = "SELL_READY";
        waitTicks = 20;
        return;
    }

    if (state === "SELL_COMMAND_WAIT") {
        returnToFarm("&a[BolsoFarm] Venda por comando concluída; voltando ao farm.");
        return;
    }

    if (state === "SELL_READY") {
        setKey("key.sneak", false);
        if (sellingCurrent === null || !hasSellAim(sellingCurrent)) {
            fallbackSellingToStorage("&e[BolsoFarm] Placa de venda indisponível; guardando os itens normalmente.");
            return;
        }
        sellingHitsLeft = SELLING_SIGN_ATTACKS;
        state = "SELL_HIT";
        waitTicks = 1;
        return;
    }

    if (state === "SELL_HIT") {
        setKey("key.sneak", false);
        if (!attackSellSign(sellingCurrent)) {
            fallbackSellingToStorage("&e[BolsoFarm] Falha ao atacar a placa; guardando os itens normalmente.");
            return;
        }
        state = "SELL_HOLD";
        waitTicks = SELLING_SIGN_HOLD_TICKS;
        return;
    }

    if (state === "SELL_HOLD") {
        setKey("key.sneak", false);
        if (--sellingHitsLeft > 0) {
            state = "SELL_HIT";
            waitTicks = 3;
        } else {
            state = "SELL_RESULT";
            waitTicks = SELLING_RESULT_WAIT_TICKS;
        }
        return;
    }

    if (state === "SELL_RESULT") {
        setKey("key.sneak", false);
        var saleCountAfterHit = inventoryItemCount(String(SELLING_ITEMS[sellingCurrent].item));
        var saleProgressed = saleCountAfterHit < sellingCountBefore;
        if (saleProgressed) stats.soldItems += sellingCountBefore - saleCountAfterHit;
        var remainingSale = findSellableInventory();
        if (remainingSale === null) {
            sellingCurrent = null;
            sellingNoProgressChecks = 0;
            sellingFailedThisCycle = false;
            storageFailedThisCycle = false;
            returnToFarm("&a[BolsoFarm] Venda concluída; voltando ao farm.");
            return;
        }
        if (remainingSale === sellingCurrent) {
            var currentCount = saleCountAfterHit;
            if (!saleProgressed) sellingNoProgressChecks++;
            else sellingNoProgressChecks = 0;
            sellingCountBefore = currentCount;
            if (sellingNoProgressChecks >= SELLING_MAX_NO_PROGRESS) {
                fallbackSellingToStorage("&e[BolsoFarm] A placa não confirmou a venda; guardando os itens normalmente.");
                return;
            }
            sellingHitsLeft = SELLING_SIGN_ATTACKS;
            state = "SELL_HIT";
            waitTicks = 1;
            return;
        }
        // O próximo item possui outra home: aplica /esconder, teleporta e pula de novo.
        sellingCurrent = null;
        beginSelling();
        return;
    }

    if (state === "FARM_WARP") {
        recoveryAttempts = 0;
        farmLastToolId = null;
        farmLastRemaining = -1;
        farmNoWearTicks = 0;
        // Cada retorno à farm inicia uma nova decisão: uma venda que falhou
        // antes não pode bloquear as vendas das próximas coletas.
        sellingFailedThisCycle = false;
        storageFailedThisCycle = false;
        sellingNoProgressChecks = 0;
        // Ao ligar ou voltar à farm, só repara no limite configurado.
        var entryRepairTarget = findRepairTarget();
        if (entryRepairTarget !== null) {
            var entryItem = Player.getInventory().getStackInSlot(entryRepairTarget.slot);
            var entryRemaining = entryItem === null ? 0 : entryItem.getMaxDamage() - entryItem.getDamage();
            var shouldRepairOnEntry = entryItem !== null && entryRemaining <= LOW_DURABILITY;
            initialStartupRepairPending = false;
            pendingLowDurabilityRepair = false;
            if (shouldRepairOnEntry) {
                beginFreshRepairCycle();
                return;
            }
        }
        initialStartupRepairPending = false;
        pendingLowDurabilityRepair = false;
        // Memoriza/equipa uma ferramenta antes de habilitar o autoclick. Isso
        // impede que uma troca manual de slot deixe a macro batendo com a mão.
        var initialFarmTool = findHeldRepairTarget();
        if (initialFarmTool === null || initialFarmTool.remaining <= 0) {
            initialFarmTool = findHotbarTool();
            if (initialFarmTool !== null) selectHotbarSlot(initialFarmTool.slot);
        }
        farmToolSlot = initialFarmTool === null ? -1 : initialFarmTool.slot;
        state = "FARMING";
        ChatLib.chat("&a[BolsoFarm] Farm retomado.");
        resumeMovement();
        return;
    }

    if (state === "FARMING") {
        if (!isAtFarmHome()) {
            farmWrongLocationTicks++;
            if (farmWrongLocationTicks >= 40) {
                farmWrongLocationTicks = 0;
                stopCombat();
                returnToFarm("&e[BolsoFarm] Fora do ponto da mobtrap; voltando para " + HOME_FARM + ".");
                return;
            }
        } else {
            farmWrongLocationTicks = 0;
        }
        var heldItem = Player.getHeldItem();
        if (heldItem !== null && TOOL_MATERIALS[heldItem.getRegistryName()] !== undefined && heldItem.getDamage() >= heldItem.getMaxDamage()) {
            stopCombat();
            ChatLib.chat("&e[BolsoFarm] Ferramenta quebrada detectada; buscando reposição.");
            beginToolRestock();
            return;
        }
        if (heldItem === null || TOOL_MATERIALS[heldItem.getRegistryName()] === undefined) {
            var rememberedTool = farmToolSlot >= 0 ? Player.getInventory().getStackInSlot(farmToolSlot) : null;
            if (rememberedTool !== null && TOOL_MATERIALS[rememberedTool.getRegistryName()] !== undefined &&
                rememberedTool.getDamage() < rememberedTool.getMaxDamage() && selectHotbarSlot(farmToolSlot)) {
                ChatLib.chat("&e[BolsoFarm] Ferramenta da farm restaurada no slot " + (farmToolSlot + 1) + ".");
                return;
            }
            var availableTool = findInventoryTool();
            if (availableTool !== null && equipInventoryTool(availableTool)) {
                farmToolSlot = getHeldHotbarIndex();
                ChatLib.chat("&e[BolsoFarm] Ferramenta do inventário equipada: " + availableTool.name + ".");
            } else {
                beginToolRestock();
            }
            return;
        }

        // Proteção imediata da ferramenta equipada: não espera a varredura do inventário.
        var heldRemainingNow = heldItem.getMaxDamage() - heldItem.getDamage();
        if (heldRemainingNow <= LOW_DURABILITY) {
            var immediateTarget = {
                slot: getHeldHotbarIndex(),
                name: ChatLib.removeFormatting(heldItem.getName()),
                toolId: heldItem.getRegistryName(),
                materialId: TOOL_MATERIALS[heldItem.getRegistryName()],
                remaining: heldRemainingNow
            };
            stopCombat();
            beginRepairLikeStartup();
            return;
        }

        var heldRemaining = heldItem.getMaxDamage() - heldItem.getDamage();
        if (farmLastToolId !== heldItem.getRegistryName() || heldRemaining < farmLastRemaining) {
            farmLastToolId = heldItem.getRegistryName();
            farmLastRemaining = heldRemaining;
            farmNoWearTicks = 0;
        } else {
            farmNoWearTicks++;
        }
        if (farmNoWearTicks >= FARM_STALL_TICKS) {
            farmNoWearTicks = 0;
            returnToFarm("&e[BolsoFarm] A ferramenta não desgastou por 60s; reiniciando na /home mob.");
            return;
        }

        if (discardConfiguredItems()) return;

        // A ferramenta na mão tem prioridade: impede falha de leitura da hotbar inteira.
        var target = findHeldRepairTarget();
        if (target === null) target = findRepairTarget();
        if (target !== null && target.remaining <= LOW_DURABILITY) {
            if (beginStorage()) return;
            beginSelectedMaintenance(target);
            return;
        }
        beginStorage();
        return;
    }

    if (state === "STORAGE_WARP") {
        // Na primeira coluna, o topo é materiais e as quatro linhas abaixo recebem drops.
        openStorageChest();
        return;
    }

    if (state === "RESTOCK_WARP") {
        // Regra de instalação: /home baus deve apontar para o primeiro baú duplo (materiais).
        openStorageChest();
        return;
    }

    if (state === "STORAGE_AIM_WAIT") {
        clickAimedStorageChest();
        return;
    }

    if (state === "STORAGE_OPEN_RELEASE") {
        setKey("key.use", false);
        state = "STORAGE_WAIT_CONTAINER";
        waitTicks = 12;
        return;
    }

    if (state === "STORAGE_REALIGN_RIGHT") {
        setKey("key.right", false);
        setKey("key.left", true);
        state = "STORAGE_REALIGN_LEFT";
        waitTicks = 3;
        return;
    }

    if (state === "STORAGE_REALIGN_LEFT") {
        setKey("key.left", false);
        // Completa a mesma cruz de microajustes do BolsoArcos. Shift permanece
        // pressionado do começo ao fim, para nunca sair do corredor do baú.
        setKey("key.sneak", true);
        setKey("key.forward", true);
        state = "STORAGE_REALIGN_FORWARD";
        waitTicks = 3;
        return;
    }

    if (state === "STORAGE_REALIGN_FORWARD") {
        setKey("key.forward", false);
        setKey("key.sneak", true);
        setKey("key.back", true);
        state = "STORAGE_REALIGN_BACK";
        waitTicks = 6;
        return;
    }

    if (state === "STORAGE_REALIGN_BACK") {
        setKey("key.back", false);
        setKey("key.sneak", true);
        setKey("key.forward", true);
        state = "STORAGE_REALIGN_CENTER";
        waitTicks = 3;
        return;
    }

    if (state === "STORAGE_REALIGN_CENTER") {
        setKey("key.forward", false);
        setKey("key.sneak", false);
        chestOpenAttempts = 0;
        openStorageChest();
        return;
    }

    if (state === "STORAGE_WAIT_CONTAINER") {
        var container = Player.getContainer();
        if (container === null || container.getSize() < 63) {
            // Lag pode impedir a primeira abertura. Uma segunda tentativa é segura;
            // após isso, retorna ao farm sem se deslocar pelo corredor às cegas.
            if (chestOpenAttempts < chestOpenRetryLimit()) {
                ChatLib.chat("&e[BolsoFarm] Baú não abriu; tentando novamente.");
                openStorageChest();
            } else {
                if (tryStorageChestRealign()) return;
                if (storageMode === "RESTOCK") {
                    handleMissingRepairMaterial(repairTarget);
                } else if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
                    scheduleAutoRestart("baú de materiais não abriu; tentando novamente pela /home mob.", "timeout");
                } else if (storageMode === "DEPOSIT" && usingTemporaryStorageHome) {
                    retryStorageFromMainHome("&e[BolsoFarm] Home temporária não abriu um baú; voltando pela /home baus principal.");
                } else {
                    recoverStorageToFarm("&c[BolsoFarm] Baú não abriu após as tentativas; voltando ao farm em segurança.");
                }
            }
            return;
        }
        if (storageMode === "DEPOSIT" && beginTemporaryStorageHomeSave()) return;
        storageRealignAttempts = 0;
        state = storageMode === "RESTOCK" || storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE" ? "RESTOCK_FIND" : "STORAGE_DEPOSIT";
        waitTicks = 1;
        return;
    }

    if (state === "STORAGE_DEPOSIT") {
        if (pendingStorageSlots.length === 0) {
            setKey("key.inventory", true);
            state = "STORAGE_CLOSE";
            waitTicks = 2;
            return;
        }
        try {
            var playerSlot = pendingStorageSlots[0];
            var stack = Player.getInventory().getStackInSlot(playerSlot);
            if (stack === null) {
                pendingStorageSlots.shift();
                waitTicks = 1;
                return;
            }
            depositAttempt = {
                playerSlot: playerSlot,
                registryName: stack.getRegistryName(),
                stackSize: stack.getStackSize()
            };
            var openContainer = Player.getContainer();
            openContainer.click(storageContainerSlot(openContainer, playerSlot), true);
            state = "STORAGE_CHECK_DEPOSIT";
            waitTicks = STORAGE_TRANSFER_DELAY_TICKS;
        } catch (error) {
            recoverStorageToFarm("&c[BolsoFarm] Falha ao mover item para o baú; retornando em segurança.");
            return;
        }
        return;
    }

    if (state === "RESTOCK_FIND") {
        if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
            var toolSlot = findToolInOpenChest(Player.getContainer());
            if (toolSlot === -1) {
                tryNextMaterialChest();
                return;
            }
            try {
                var heldSlot = getHeldHotbarIndex();
                var toolContainer = Player.getContainer();
                toolContainer.click(toolSlot, false);
                toolContainer.click(storageContainerSlot(toolContainer, heldSlot), false);
                // Em troca de ferramenta, devolve a arma gasta ao slot que tinha a reserva.
                if (storageMode === "REPLACE") toolContainer.click(toolSlot, false);
                state = "RESTOCK_CHECK";
                waitTicks = 2;
            } catch (error) {
                disableForMissingMaterial("não foi possível equipar a ferramenta do baú.");
            }
            return;
        }

        var materialSlot = findMaterialInOpenChest(Player.getContainer(), repairTarget.materialId);
        if (materialSlot === -1) {
            tryNextMaterialChest();
            return;
        }
        try {
            Player.getContainer().click(materialSlot, true);
            stats.restocks++;
            state = "RESTOCK_CHECK";
            waitTicks = 2;
        } catch (error) {
            returnToFarm("&c[BolsoFarm] Não foi possível retirar o material do baú.");
        }
        return;
    }

    if (state === "RESTOCK_CHECK") {
        if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
            var equippedTool = findHotbarTool();
            if (equippedTool === null) {
                disableForMissingMaterial("a espada ou machado não chegou à hotbar.");
                return;
            }
            Player.setHeldItemIndex(equippedTool.slot);
            stats.toolRestocks++;
            setKey("key.inventory", true);
            state = "RESTOCK_CLOSE";
            waitTicks = 2;
            return;
        }

        if (countMaterial(repairTarget.materialId) <= 0) {
            returnToFarm("&c[BolsoFarm] O material não coube no inventário; libere um slot e tente novamente.");
            return;
        }
        setKey("key.inventory", true);
        state = "RESTOCK_CLOSE";
        waitTicks = 2;
        return;
    }

    if (state === "RESTOCK_CLOSE") {
        closeCurrentScreen();
        if (storageMode === "TOOL_RESTOCK" || storageMode === "REPLACE") {
            preferredReplacementToolId = null;
            storageMode = "DEPOSIT";
            returnToFarm("&a[BolsoFarm] Ferramenta equipada; voltando ao farm.");
            return;
        }
        startRepair(repairTarget);
        return;
    }

    if (state === "STORAGE_CHECK_DEPOSIT") {
        var remainingStack = Player.getInventory().getStackInSlot(depositAttempt.playerSlot);
        var unchanged = remainingStack !== null &&
            remainingStack.getRegistryName() === depositAttempt.registryName &&
            remainingStack.getStackSize() === depositAttempt.stackSize;

        if (remainingStack === null) {
            pendingStorageSlots.shift();
            stats.storedStacks++;
            consecutiveStorageFailures = 0;
            rememberStorageChest();
            // A confirmação chegou: envia a próxima pilha agora, mas só segue
            // após confirmar essa próxima transferência no tick seguinte.
            var nextPlayerSlot = pendingStorageSlots[0];
            var nextStack = nextPlayerSlot === undefined ? null : Player.getInventory().getStackInSlot(nextPlayerSlot);
            if (nextStack === null) {
                depositAttempt = null;
                state = "STORAGE_DEPOSIT";
                waitTicks = 0;
                return;
            }
            try {
                depositAttempt = {
                    playerSlot: nextPlayerSlot,
                    registryName: nextStack.getRegistryName(),
                    stackSize: nextStack.getStackSize()
                };
                var nextContainer = Player.getContainer();
                nextContainer.click(storageContainerSlot(nextContainer, nextPlayerSlot), true);
                state = "STORAGE_CHECK_DEPOSIT";
                waitTicks = STORAGE_TRANSFER_DELAY_TICKS;
            } catch (error) {
                recoverStorageToFarm("&c[BolsoFarm] Falha ao mover item para o baú; retornando em segurança.");
            }
            return;
        }

        // O baú ficou cheio (ou só aceitou parte da pilha): segue para a próxima posição da grade.
        depositAttempt = null;
        advanceStorageTarget();
        return;
    }

    if (state === "STORAGE_CLOSE") {
        closeCurrentScreen();
        finishStorageAfterDeposit("&a[BolsoFarm] Inventário limpo; voltando ao farm.");
        return;
    }

    if (state === "STORAGE_CLOSE_FOR_ROW") {
        chestOpenAttempts = 0;
        openStorageChest();
        return;
    }

    if (state === "STORAGE_CLOSE_FOR_MOVE") {
        closeCurrentScreen();
        moveToNextChestColumn();
        return;
    }

    if (state === "RESTOCK_CLOSE_FOR_MOVE") {
        closeCurrentScreen();
        moveToNextChestColumn();
        return;
    }

    if (state === "RESTOCK_CLOSE_FOR_ROW") {
        closeCurrentScreen();
        chestOpenAttempts = 0;
        openStorageChest();
        return;
    }

    if (state === "STORAGE_MOVE_RIGHT") {
        setKey("key.right", false);
        setKey("key.sneak", false);
        storageColumn++;
        stats.chestColumns++;
        chestOpenAttempts = 0;
        openStorageChest();
        return;
    }

    if (state === "REPAIR_WARP") {
        if (repairTarget === null || countMaterial(repairTarget.materialId) <= 0) {
            returnToFarm("&c[BolsoFarm] Material de reparo ausente; operação cancelada.");
            return;
        }
        var nearbyRepairBlock = findNearbyRepairBlock();
        if (nearbyRepairBlock === null) {
            returnToFarm("&c[BolsoFarm] Não encontrei bloco de ferro ao alcance do /home reparar.");
            return;
        }
        aimAtRepairTarget(nearbyRepairBlock);
        // O reparador só funciona com a ferramenta certa realmente selecionada na mão.
        var heldForRepair = findHeldRepairTarget();
        if (heldForRepair === null) {
            var replacement = findHotbarTool();
            if (replacement === null) replacement = findInventoryTool();
            if (replacement === null || !equipInventoryTool(replacement)) {
                beginToolRestock();
                return;
            }
            waitTicks = 3;
            return;
        }
        repairTarget = heldForRepair;
        repairLastDamage = Player.getHeldItem().getDamage();
        state = "REPAIR_AIM_WAIT";
        // Dá tempo extra para o servidor terminar o /home antes do primeiro uso.
        waitTicks = 15;
        return;
    }

    if (state === "REPAIR_AIM_WAIT") {
        try {
            useSavedRepairBlock();
            state = "REPAIR_CLICK_1_RELEASE";
            waitTicks = 5;
        } catch (error) {
            returnToFarm("&c[BolsoFarm] Não foi possível clicar no bloco de reparação.");
        }
        return;
    }

    if (state === "REPAIR_CLICK_1_RELEASE" || state === "REPAIR_CLICK_2_RELEASE" || state === "REPAIR_CLICK_3_RELEASE") {
        setKey("key.use", false);
        if (state === "REPAIR_CLICK_1_RELEASE") state = "REPAIR_CLICK_2";
        else if (state === "REPAIR_CLICK_2_RELEASE") state = "REPAIR_CLICK_3";
        else {
            var repairedItem = repairTarget === null ? null : Player.getInventory().getStackInSlot(repairTarget.slot);
            if (repairedItem !== null && repairedItem.getDamage() > 0) {
                var currentDamage = repairedItem.getDamage();
                if (currentDamage >= repairLastDamage) repairNoProgressCycles++;
                else repairNoProgressCycles = 0;
                repairLastDamage = currentDamage;
                // O servidor não respondeu ao uso do reparador: não fica parado nele para sempre.
                if (repairNoProgressCycles >= 2) {
                    scheduleAutoRestart("bloco de ferro não confirmou o reparo.", "repair");
                    return;
                }
                if (countMaterial(repairTarget.materialId) > 0) {
                    // O reparador do servidor pode precisar de mais de um ciclo de três usos.
                    state = "REPAIR_CLICK_1";
                    waitTicks = 10;
                } else {
                    if (REPAIR_MAINTENANCE_MODE === "repair_only_stop") {
                        disableForMissingMaterial("acabou " + materialName(repairTarget.materialId) + " durante o reparo; modo somente reparar.");
                    } else {
                        beginMaterialRestock(repairTarget);
                    }
                }
                return;
            }
            repairTarget = null;
            stats.repairs++;
            returnToFarm("&a[BolsoFarm] Reparo concluído em 100%; voltando ao farm.");
            return;
        }
        waitTicks = 10;
        return;
    }

    if (state === "REPAIR_CLICK_1" || state === "REPAIR_CLICK_2" || state === "REPAIR_CLICK_3") {
        try {
            // Reaplica a mira e usa o alvo salvo em cada tentativa. O mouse do jogador
            // não pode desviar a interação para o ar ou para outro bloco.
            useSavedRepairBlock();
        } catch (error) {
            returnToFarm("&c[BolsoFarm] Falha ao clicar no bloco de reparação.");
            return;
        }
        if (state === "REPAIR_CLICK_1") state = "REPAIR_CLICK_1_RELEASE";
        else if (state === "REPAIR_CLICK_2") state = "REPAIR_CLICK_2_RELEASE";
        else state = "REPAIR_CLICK_3_RELEASE";
        waitTicks = 5;
    }
});
