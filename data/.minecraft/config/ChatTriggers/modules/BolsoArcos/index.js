// =============================================================================
// BolsoArcos — coleta linhas e arcos, repara lote completo e descarta o pronto.
// As rotas de /home baus e /home arcosred mantêm progressos independentes.
// =============================================================================
ChatLib.chat("&a[BolsoArcos] Módulo carregado. Use &f/bolsoarcos&a para iniciar.");

// Leitor YAML compacto: o config.yml usa somente seções e chave: valor.
function yaml(t) { var r = {}, p = [r]; String(t || "").split(/\r?\n/).forEach(function (l) { if (/^\s*$|^\s*#/.test(l)) return; var m = l.match(/^(\s*)([^:#][^:]*):\s*(.*)$/); if (!m) return; var d = Math.floor(m[1].length / 2), k = m[2].trim(), v = m[3].trim(); while (p.length > d + 1) p.pop(); var q = p[d] || r; if (!v) { q[k] = {}; p[d + 1] = q[k]; } else q[k] = v.replace(/^['"]|['"]$/g, ""); }); return r; }
var C = yaml(FileLib.read("BolsoArcos", "config.yml") || "");
function V(section, key, fallback) { return C[section] && C[section][key] !== undefined ? C[section][key] : fallback; }
function logArcos(kind, message) {
    try {
        var file = kind === "ERRO" ? "data/error-log.txt" : "data/diagnostic-log.txt";
        var old = FileLib.read("BolsoArcos", file) || "";
        if (old.length > 50000) old = old.substring(old.length - 36000);
        FileLib.write("BolsoArcos", file, old + "[" + new Date().toLocaleTimeString() + "] [" + kind + "] [" + state + "] " + message + "\n");
    } catch (ignored) { }
}
var HOME_BOWS = V("homes", "bows", "/home arcosred"), HOME_STRINGS = V("homes", "strings", "/home baus"), HOME_TRASH = V("homes", "trash", "/home lixo"), HOME_BOWS_TEMP = V("homes", "temporaryBows", "/home bolsoarcos"), HOME_STRINGS_TEMP = V("homes", "temporaryStrings", "/home bolsoarcoslinha");
var BOW = V("items", "bow", "minecraft:bow"), STRING = V("items", "string", "minecraft:string"), REPAIR = V("repair", "command", "/reparar -a");
var PROTECTED_PREPARE_ITEMS = String(V("inventory", "protectedItems", "minecraft:diamond_sword,minecraft:diamond_block")).split(",").map(function (id) { return id.replace(/^\s+|\s+$/g, ""); }).filter(function (id) { return id !== ""; });
var MIN_BOWS_TO_REPAIR = Math.max(1, Math.min(27, parseInt(V("inventory", "minimumBowsToRepair", 26)) || 26));
var REPAIR_MODE = String(V("repair", "repairMode", "command_then_manual")).toLowerCase();
var MIN_REPAIR_STRING = Math.max(1, parseInt(V("repair", "minimumStringForFullRepair", 256)) || 256);
var MANUAL_REPAIR_ENABLED = String(V("repair", "manualFallbackEnabled", "true")).toLowerCase() !== "false";
var HOME_MANUAL_REPAIR = V("repair", "manualHome", "/home reparar");
var WARP_WAIT = Math.max(20, parseInt(V("timing", "warpWaitTicks", 70)) || 70), CHEST_WAIT = Math.max(2, parseInt(V("timing", "chestWaitTicks", 14)) || 14), REPAIR_WAIT = Math.max(10, parseInt(V("timing", "repairWaitTicks", 40)) || 40), DROP_WAIT = Math.max(1, parseInt(V("timing", "dropWaitTicks", 2)) || 2);
var TAKE_WAIT = Math.max(1, parseInt(V("timing", "takeWaitTicks", 8)) || 8);
var TRANSFER_CLICK_WAIT = Math.max(1, parseInt(V("timing", "transferClickWaitTicks", 5)) || 5);
var TRANSFER_CONFIRM_WAIT = Math.max(1, parseInt(V("timing", "transferConfirmWaitTicks", 8)) || 8);
var QUICK_BOW_CONFIRM_WAIT = Math.max(1, parseInt(V("timing", "quickBowConfirmWaitTicks", 2)) || 2);
var MANUAL_REPAIR_WAIT = Math.max(2, parseInt(V("timing", "manualRepairWaitTicks", 12)) || 12);
var ALIGN_STEP = Math.max(1, parseInt(V("timing", "alignStepTicks", 1)) || 1);
var TEMP_HOME_WAIT = Math.max(5, parseInt(V("timing", "temporaryHomeWaitTicks", 20)) || 20);
var RESUME_FARM_WHEN_FINISHED = String(V("behavior", "resumeFarmWhenFinished", "true")).toLowerCase() !== "false";
var RESUME_FARM_COMMAND = String(V("behavior", "resumeFarmCommand", "/bolsofarm start"));
var STATE_TIMEOUT_TICKS = Math.max(200, parseInt(V("safety", "stateTimeoutSeconds", 60)) * 20 || 1200);
var MAX_COLUMNS = Math.max(1, parseInt(V("storage", "maxColumns", 128)) || 128), STEP = Math.max(1, parseInt(V("storage", "stepTicks", 15)) || 15);
var EMPTY_COLUMNS_BEFORE_STOP = Math.max(1, parseInt(V("storage", "emptyColumnsBeforeStop", 10)) || 10);
var RESET_PROGRESS_ON_EXHAUSTION = String(V("storage", "resetProgressOnExhaustion", "true")).toLowerCase() !== "false";
var pitch = String(V("storage", "rowPitch", "-53,-34,0,34,53")).split(",").map(parseFloat); while (pitch.length < 5) pitch.push(0);
try { var savedPitch = JSON.parse(FileLib.read("BolsoArcos", "data/chest-pitch.json") || "null"); if (savedPitch && savedPitch.length === 5) pitch = savedPitch; } catch (e) { }
// Alvos exatos, separados por parede. Mantém compatibilidade com a calibração
// antiga de pitch quando o arquivo ainda não existe.
var chestTargets = { bows: [null, null, null, null, null], strings: [null, null, null, null, null] };
try {
    var savedTargets = JSON.parse(FileLib.read("BolsoArcos", "data/chest-targets.json") || "{}");
    ["bows", "strings"].forEach(function (which) {
        if (savedTargets[which] && savedTargets[which].length === 5) chestTargets[which] = savedTargets[which];
    });
} catch (e) { }
var on = false, state = "IDLE", wait = 0, terrain = null, replay = 0, alignStage = 0, bowsTempReady = false, stringsTempReady = false, lineHomeAfter = "BOWS", pendingTransfer = null, serverReportedNoString = false, progress = { strings: { column: 0, row: 0 }, bows: { column: 0, row: 0 } };
var recoveryAttempts = 0, transferFailures = 0, quickBowTransfer = null;
var emptyColumns = { strings: 0, bows: 0 };
var MAX_RECOVERY_ATTEMPTS = Math.max(0, parseInt(V("safety", "retryAttempts", 3)) || 3);
var RECOVERY_WAIT = Math.max(20, parseInt(V("safety", "retryWaitTicks", 40)) || 40);
var HOME_FALLBACK_AFTER_ATTEMPTS = Math.max(1, parseInt(V("safety", "homeFallbackAfterAttempts", 2)) || 2);
var observedState = "IDLE", stateStallTicks = 0;
var lastLoggedState = "";
var sessionStartedAt = 0;
var stats = { repairCycles: 0, droppedBows: 0 };
function sessionDuration() { var total = sessionStartedAt <= 0 ? 0 : Math.floor((Date.now() - sessionStartedAt) / 1000), minutes = Math.floor(total / 60), seconds = total % 60; return minutes + "m " + seconds + "s"; }
function showSessionStats() { if (sessionStartedAt <= 0) return; ChatLib.chat("&8&m------------------------------"); ChatLib.chat("&e[BolsoArcos] &fSessão encerrada &7(" + sessionDuration() + ")"); ChatLib.chat("&7Ciclos de reparo iniciados: &a" + stats.repairCycles + " &7| Arcos descartados: &a" + stats.droppedBows); ChatLib.chat("&7Arcos no inventário: &f" + mainBowCount() + "/27 &7| Linha: &f" + stringCount()); ChatLib.chat("&7Progresso linhas: &f" + (progress.strings.column + 1) + "/" + (progress.strings.row + 1) + " &7| arcos: &f" + (progress.bows.column + 1) + "/" + (progress.bows.row + 1)); ChatLib.chat("&8&m------------------------------"); }
try { var saved = JSON.parse(FileLib.read("BolsoArcos", "data/progress.json") || "{}"); ["strings", "bows"].forEach(function (which) { var old = saved[which]; if (typeof old === "object" && old !== null) { progress[which].column = Math.max(0, parseInt(old.column) || 0); progress[which].row = Math.max(0, Math.min(4, parseInt(old.row) || 0)); } else progress[which].column = Math.max(0, parseInt(old) || 0); }); } catch (e) { }
function save() { try { FileLib.write("BolsoArcos", "data/progress.json", JSON.stringify(progress)); } catch (e) { } }
function resetProgressForNewRun() {
    progress = { strings: { column: 0, row: 0 }, bows: { column: 0, row: 0 } };
    emptyColumns = { strings: 0, bows: 0 };
    save();
}
function key(name, pressed) { try { var s = Client.getMinecraft().field_71474_y, b = name === "sneak" ? s.field_74311_E : (name === "jump" ? s.field_74314_A : (name === "left" ? s.field_74370_x : s.field_74366_z)); Java.type("net.minecraft.client.settings.KeyBinding").func_74510_a(b.func_151463_i(), pressed); } catch (e) { } }
function stopKeys() { key("sneak", false); key("left", false); key("right", false); key("jump", false); }
function goHome(command) { ChatLib.chat("&b[BolsoArcos] &7Indo para: &f" + command); ChatLib.say(command); }
function terminalFail(reason) { logArcos("ERRO", reason + " | terreno=" + (terrain || "-") + " | arcos=" + mainBowCount() + " | fio=" + stringCount()); on = false; state = "IDLE"; stopKeys(); ChatLib.chat("&c[BolsoArcos] Parada: " + reason); showSessionStats(); try { ChatLib.command("bolsociclo complete repair", true); } catch (ignoredCycle) { } }

function fail(reason) {
    // Uma abertura/troca de baú pode falhar por lag. Não pule a reparação na primeira falha.
    if (on && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
        recoveryAttempts++;
        // A home temporária pode ter sido salva em um ponto ruim ou o jogador
        // pode ter ficado desalinhado. Na segunda tentativa, volta pela home
        // principal e refaz o caminho até a coluna salva antes de desistir.
        if (terrain !== null && recoveryAttempts === HOME_FALLBACK_AFTER_ATTEMPTS) {
            if (terrain === "bows") bowsTempReady = false;
            else stringsTempReady = false;
            ChatLib.chat("&e[BolsoArcos] Reposicionando pela home principal antes de desistir do baú.");
            logArcos("RECUPERAÇÃO", "home temporária invalidada; nova tentativa via home principal.");
        }
        stopKeys(); close();
        state = "RECOVER";
        wait = RECOVERY_WAIT;
        logArcos("RECUPERAÇÃO", reason + " | tentativa=" + recoveryAttempts + "/" + MAX_RECOVERY_ATTEMPTS + " | terreno=" + (terrain || "-"));
        ChatLib.chat("&e[BolsoArcos] Falha temporária; retomando coleta (" + recoveryAttempts + "/" + MAX_RECOVERY_ATTEMPTS + ").");
        return;
    }
    terminalFail(reason);
}
function finishSuccessfully(reason) {
    on = false;
    state = "IDLE";
    stopKeys();
    logArcos("FIM", reason + " | arcos=" + mainBowCount() + " | fio=" + stringCount());
    ChatLib.chat("&a[BolsoArcos] Concluída: " + reason);
    showSessionStats();
    if (!RESUME_FARM_WHEN_FINISHED || RESUME_FARM_COMMAND.replace(/^\s+|\s+$/g, "") === "") return;
    ChatLib.chat("&a[BolsoArcos] Reparação concluída de verdade; religando BolsoFarm.");
    ChatLib.command(RESUME_FARM_COMMAND.replace(/^\s*\//, ""), true);
}
function close() { try { Client.getMinecraft().func_147108_a(null); } catch (e) { } }
function savedChestHit() {
    try {
        var target = terrain === null ? null : chestTargets[terrain][progress[terrain].row];
        if (target === null || target === undefined || isNaN(target.x) || isNaN(target.y) || isNaN(target.z)) return null;
        var BlockPos = Java.type("net.minecraft.util.BlockPos");
        var EnumFacing = Java.type("net.minecraft.util.EnumFacing");
        var Vec3 = Java.type("net.minecraft.util.Vec3");
        var MovingObjectPosition = Java.type("net.minecraft.util.MovingObjectPosition");
        // O corredor avança uma coluna à direita, no eixo X, como nas outras
        // macros. Cada parede possui sua própria origem calibrada.
        var x = Number(target.x) + progress[terrain].column;
        var y = Number(target.y), z = Number(target.z);
        var pos = new BlockPos(x, y, z);
        var side = EnumFacing.valueOf(String(target.side || "SOUTH").toUpperCase());
        return new MovingObjectPosition(new Vec3(x + 0.5, y + 0.5, z + 0.5), side, pos);
    } catch (e) { logArcos("ERRO", "alvo calibrado inválido: " + e); return null; }
}
function openChest() {
    var minecraft = Client.getMinecraft(), p = minecraft.field_71439_g;
    p.field_70177_z = 180; p.field_70126_B = 180;
    p.field_70125_A = pitch[progress[terrain].row]; p.field_70127_C = pitch[progress[terrain].row];
    // Sem renovar este alvo, o Minecraft reutiliza o raytrace do baú anterior
    // (normalmente o do meio), mesmo após a mira mudar de altura.
    minecraft.field_71476_x = savedChestHit() || p.func_174822_a(5, 1);
    var hit = minecraft.field_71476_x;
    if (hit === null || hit === undefined || hit.func_178782_a() === null) return false;
    var block = minecraft.field_71441_e.func_180495_p(hit.func_178782_a()).func_177230_c();
    if (String(block.func_149739_a()).toLowerCase().indexOf("chest") === -1) return false;
    minecraft.func_147121_ag();
    return true;
}
function stackAt(slot) { return Player.getInventory().getStackInSlot(slot); }
function isId(item, id) { return item !== null && item.getRegistryName() === id; }
function isRepairedBow(item) { return isId(item, BOW) && item.getDamage() <= 0; }
// Conta a linha em todo o inventário. A preparação tenta colocá-la na hotbar,
// mas a decisão de buscar baús nunca ignora pilhas que já estão com o jogador.
function stringCount() { var total = 0; for (var i = 0; i < 36; i++) if (isId(stackAt(i), STRING)) total += stackAt(i).getStackSize(); return total; }
function bowCount() { var total = 0; for (var i = 0; i < 36; i++) if (isId(stackAt(i), BOW)) total++; return total; }
function mainBowCount() { var total = 0; for (var i = 9; i < 36; i++) if (isId(stackAt(i), BOW)) total++; return total; }
function mainHasOnlyBowsAndStrings() { for (var i = 9; i < 36; i++) { var item = stackAt(i); if (item !== null && !isId(item, BOW) && !isId(item, STRING)) return false; } return true; }
// Economia: só inicia reparo com o lote configurado. O padrão 26 reserva um
// dos 27 slots principais para a espada protegida.
function canRepairCurrentBatch() { return mainBowCount() >= MIN_BOWS_TO_REPAIR; }
function chestSlots(c) { return c.getSize() - 36; }
function validChest(c) { return c !== null && c.getSize() >= 63; }
function containerSlot(c, inventorySlot) { var base = chestSlots(c); return inventorySlot < 9 ? base + 27 + inventorySlot : base + inventorySlot - 9; }
function findChestItem(c, id) { for (var i = 0; i < chestSlots(c); i++) if (isId(c.getStackInSlot(i), id)) return i; return -1; }
function isProtectedPrepareItem(item) {
    // Arco jamais é protegido aqui: na preparação ele deve dar lugar à linha.
    return item !== null && !isId(item, BOW) && PROTECTED_PREPARE_ITEMS.indexOf(item.getRegistryName()) >= 0;
}
function hotbarStringStacks() { var total = 0; for (var i = 0; i < 9; i++) if (isId(stackAt(i), STRING)) total++; return total; }
function requiredStringStacks() { return Math.max(1, Math.ceil(MIN_REPAIR_STRING / 64)); }
// A API do inventário pode atrasar alguns ticks após uma troca no baú. As pilhas
// já visíveis na hotbar são a confirmação prática do lote, evitando voltar
// infinitamente à parede de linha quando as quatro pilhas já foram separadas.
function hasEnoughStringForBatch() { return !serverReportedNoString && stringCount() >= MIN_REPAIR_STRING; }
function nextStringTarget() {
    // Mesmo com hotbar cheia, substitui um item que não é espada/bloco. O item
    // substituído volta ao baú aberto pela própria transação, sem ser perdido.
    for (var i = 0; i < 9; i++) { var item = stackAt(i); if (isId(item, STRING) && item.getStackSize() < 64) return i; }
    if (hotbarStringStacks() >= requiredStringStacks()) return -1;
    // Prioridade pedida: arco da hotbar vira linha antes de osso/outro drop.
    for (var bowSlot = 0; bowSlot < 9; bowSlot++) if (isId(stackAt(bowSlot), BOW) && !isProtectedPrepareItem(stackAt(bowSlot))) return bowSlot;
    for (var slot = 0; slot < 9; slot++) if (!isProtectedPrepareItem(stackAt(slot))) return slot;
    return -1;
}
function findInventoryString() { for (var i = 9; i < 36; i++) if (isId(stackAt(i), STRING)) return i; return -1; }
function nextBowTarget() {
    for (var i = 9; i < 36; i++) if (stackAt(i) === null) return i;
    // Inventário cheio: qualquer item pode voltar ao baú para abrir espaço ao
    // arco. A exceção é somente o que foi protegido na configuração (espada e
    // bloco de reparação); linha fora da hotbar também pode ser trocada.
    for (var slot = 9; slot < 36; slot++) { var item = stackAt(slot); if (!isId(item, BOW) && !isProtectedPrepareItem(item)) return slot; }
    return -1;
}
function rawContainerClick(slot) {
    // Usa a mesma API de clique dos outros módulos. O windowClick nativo estava
    // aceitando localmente e sendo revertido pelo servidor ao abrir outro baú.
    Player.getContainer().click(slot, false);
}
function stackSize(item) { return item === null ? 0 : item.getStackSize(); }
function transferWasConfirmed(transfer) {
    var received = stackAt(transfer.inventorySlot);
    if (!isId(received, transfer.expectedId)) return false;
    // Se o destino já era uma pilha parcial de linha, o ID sozinho não prova
    // nada: a quantidade precisa aumentar depois da resposta do servidor.
    return transfer.destinationWasExpected !== true || stackSize(received) > transfer.destinationSize;
}
function isTransferContainerStillOpen(transfer) {
    try {
        var active = Player.getContainer();
        return active !== null && active.getSize() === transfer.containerSize && transfer.destination >= 0 && transfer.destination < active.getSize();
    } catch (ignored) { return false; }
}
function beginChestTransfer(c, chestSlot, inventorySlot, expectedId) {
    try {
        var destinationStack = stackAt(inventorySlot);
        pendingTransfer = { source: chestSlot, destination: containerSlot(c, inventorySlot), inventorySlot: inventorySlot, expectedId: expectedId, destinationWasExpected: isId(destinationStack, expectedId), destinationSize: stackSize(destinationStack), containerSize: c.getSize() };
        rawContainerClick(chestSlot);
        return true;
    } catch (e) { fail("falha ao mover item: " + e); return false; }
}
function beginQuickBowTransfer(c, chestSlot) {
    try {
        // Só usa Shift-click quando há slot principal vazio. Assim não troca nem
        // devolve item algum e o arco chega ao inventário em uma única ação.
        quickBowTransfer = { before: mainBowCount() };
        c.click(chestSlot, true);
        return true;
    } catch (e) { quickBowTransfer = null; return false; }
}
function moveInventoryStringToHotbar(from, to) {
    try {
        var container = Player.getContainer();
        var destinationStack = stackAt(to);
        pendingTransfer = { source: containerSlot(container, from), destination: containerSlot(container, to), inventorySlot: to, expectedId: STRING, destinationWasExpected: isId(destinationStack, STRING), destinationSize: stackSize(destinationStack), containerSize: container.getSize() };
        rawContainerClick(pendingTransfer.source);
        state = "HOTBAR_TRANSFER_PLACE";
        return true;
    } catch (e) { fail("falha ao organizar linhas: " + e); return false; }
}
function homeToSetHome(home) { var match = String(home).match(/^\s*\/home\s+(.+?)\s*$/i); return match === null ? null : "/sethome " + match[1]; }
function beginTerrain(which) { terrain = which; var direct = which === "bows" ? bowsTempReady : stringsTempReady; var tempHome = which === "bows" ? HOME_BOWS_TEMP : HOME_STRINGS_TEMP; goHome(direct ? tempHome : (which === "strings" ? HOME_STRINGS : HOME_BOWS)); replay = direct ? 0 : progress[which].column; state = "BACK"; wait = WARP_WAIT; }
function chooseCycle() { beginTerrain(hasEnoughStringForBatch() ? "bows" : "strings"); }
function checkInventoryFirst() {
    // Nunca mistura arcos que já estavam no inventário com uma nova retirada.
    // Primeiro abastece linha se necessário, completa os 27 slots e só então repara.
    if (bowCount() === 0) { chooseCycle(); return; }
    if (!hasEnoughStringForBatch()) beginTerrain("strings");
    // Mesmo com o lote já cheio, entra primeiro no /home arcosred. Assim a
    // home temporária nunca é criada no local onde a macro foi ligada.
    else beginTerrain("bows");
}
function resetSearchProgressAfterExhaustion() { progress = { strings: { column: 0, row: 0 }, bows: { column: 0, row: 0 } }; save(); ChatLib.chat("&e[BolsoArcos] Parede verificada até o fim; próxima reparação começará no primeiro baú."); logArcos("BUSCA", "parede esgotada; progresso de arcos e linhas resetado para o início."); }
function advanceChest() {
    var current = progress[terrain];
    current.row++;
    save();
    if (current.row < 5) { state = "OPEN"; wait = 2; return; }
    current.row = 0;
    current.column++;
    emptyColumns[terrain]++;
    save();
    if (emptyColumns[terrain] >= EMPTY_COLUMNS_BEFORE_STOP) {
        var itemName = terrain === "strings" ? "linha" : "arco";
        if (RESET_PROGRESS_ON_EXHAUSTION) resetSearchProgressAfterExhaustion();
        terminalFail("nenhum " + itemName + " nas últimas " + EMPTY_COLUMNS_BEFORE_STOP + " colunas; busca reiniciada no primeiro baú");
        return;
    }
    if (current.column >= MAX_COLUMNS) {
        if (RESET_PROGRESS_ON_EXHAUSTION) resetSearchProgressAfterExhaustion();
        if (terrain === "bows" && bowCount() === 0) finishSuccessfully("todos os arcos encontrados foram reparados e descartados.");
        else if (terrain === "bows") fail("acabaram os arcos antes de completar os " + MIN_BOWS_TO_REPAIR + " arcos; não reparou para não gastar dinheiro.");
        else fail("fim das " + MAX_COLUMNS + " colunas de linhas; não há linha suficiente para reparar com segurança.");
        return;
    }
    key("sneak", true); key("right", true); state = "MOVE"; wait = STEP;
}
function beginManualRepair() { goHome(HOME_MANUAL_REPAIR); state = "MANUAL_REPAIR"; wait = WARP_WAIT; }
function startRepairAndTrash() { close(); if (bowCount() === 0) { fail("não há arcos para reparar"); return; } stats.repairCycles++; if (REPAIR_MODE === "manual") { beginManualRepair(); return; } ChatLib.say(REPAIR); state = "REPAIR_WAIT"; wait = REPAIR_WAIT; }
function repairAndTrash() {
    // Só salva a home temporária enquanto está no fluxo de um baú de arcos.
    // Isso impede sobrescrever a home ao ligar a macro no /home lixo ou em outro lugar.
    var command = terrain === "bows" && state === "CHEST" ? homeToSetHome(HOME_BOWS_TEMP) : null;
    if (command !== null && on) { ChatLib.say(command); state = "BOW_HOME_CONFIRM"; wait = TEMP_HOME_WAIT; return; }
    startRepairAndTrash();
}
function saveStringHome(after) { var command = homeToSetHome(HOME_STRINGS_TEMP); if (command === null) { if (after === "REPAIR") repairAndTrash(); else beginTerrain("bows"); return; } lineHomeAfter = after; ChatLib.say(command); state = "LINE_HOME_CONFIRM"; wait = TEMP_HOME_WAIT; }
function hasDamagedBow() { for (var i = 0; i < 36; i++) { var item = stackAt(i); if (isId(item, BOW) && !isRepairedBow(item)) return true; } return false; }
function equipDamagedBow() { try { var minecraft = Client.getMinecraft(), player = minecraft.field_71439_g; for (var i = 0; i < 36; i++) { var item = stackAt(i); if (!isId(item, BOW) || isRepairedBow(item)) continue; if (i < 9) { Player.setHeldItemIndex(i); return true; } minecraft.field_71442_b.func_78753_a(player.field_71069_bz.field_75152_c, i, 0, 2, player); Player.setHeldItemIndex(0); return true; } } catch (e) { fail("falha ao equipar arco para reparo manual: " + e); } return false; }
function useManualRepairBlock() { try { Client.getMinecraft().func_147121_ag(); return true; } catch (e) { fail("falha ao usar bloco de reparo: " + e); return false; } }
function dropOneBow() { try { var p = Client.getMinecraft().field_71439_g; for (var i = 0; i < 36; i++) if (isRepairedBow(stackAt(i))) { var containerSlot = i < 9 ? 36 + i : i; Client.getMinecraft().field_71442_b.func_78753_a(p.field_71069_bz.field_75152_c, containerSlot, 1, 4, p); stats.droppedBows++; return true; } } catch (e) { fail("falha ao jogar arco: " + e); } return false; }
function calibrateLine(line, which) {
    try {
        if (on) { ChatLib.chat("&c[BolsoArcos] Desligue a macro antes de calibrar."); return; }
        if (line < 1 || line > 5) { ChatLib.chat("&cUse uma linha de 1 a 5."); return; }
        var player = Client.getMinecraft().field_71439_g;
        pitch[line - 1] = player.field_70125_A;
        FileLib.write("BolsoArcos", "data/chest-pitch.json", JSON.stringify(pitch));
        if (which !== "bows" && which !== "strings") {
            ChatLib.chat("&a[BolsoArcos] Mira da linha " + line + " salva. Para alvo exato use /bolsoarcos calibrar arcos|linhas " + line + ".");
            return;
        }
        var hit = Client.getMinecraft().field_71476_x;
        if (hit === null || hit === undefined || hit.func_178782_a() === null) throw "mire diretamente no baú";
        var pos = hit.func_178782_a();
        chestTargets[which][line - 1] = {
            x: pos.func_177958_n(), y: pos.func_177956_o(), z: pos.func_177952_p(),
            side: String(hit.field_178784_b || "SOUTH")
        };
        FileLib.write("BolsoArcos", "data/chest-targets.json", JSON.stringify(chestTargets));
        ChatLib.chat("&a[BolsoArcos] Parede de " + (which === "bows" ? "arcos" : "linhas") + ", linha " + line + " calibrada com alvo exato.");
    } catch (e) { ChatLib.chat("&c[BolsoArcos] Falha ao salvar a linha " + line + ": " + e); }
}
function showHelp() {
    ChatLib.chat("&6&m--------------- &eBolsoArcos &6&m---------------");
    ChatLib.chat("&e/bolsoarcos&7: inicia ou para a macro.");
    ChatLib.chat("&e/bolsoarcos start|stop|status|help|reset&7: comandos padronizados.");
    ChatLib.chat("&e/bolsoarcos status&7: mostra estado, rota e lote atual.");
    ChatLib.chat("&e/bolsoarcos inicio&7: zera os progressos dos dois terrenos.");
    ChatLib.chat("&e/bolsoarcos inicio linhas|arcos&7: zera só uma rota.");
    ChatLib.chat("&e/bolsoarcos calibrar arcos|linhas <1-5>&7: salva o alvo exato de cada parede.");
    ChatLib.chat("&e/bolsoarcos calibracoes&7: mostra as cinco miras salvas.");
    ChatLib.chat("&7Repara somente com &f" + MIN_BOWS_TO_REPAIR + " arcos&7 e pelo menos &f4 packs de linha&7.");
    ChatLib.chat("&7Configuração: &fBolsoArcos/config.yml");
    ChatLib.chat("&6&m---------------------------------------------");
}
function showCalibrations() {
    ChatLib.chat("&6&m---------- &eCalibrações BolsoArcos &6&m----------");
    for (var i = 0; i < 5; i++) ChatLib.chat("&a✓ &fLinha " + (i + 1) + " &7→ pitch " + pitch[i].toFixed(2));
    ChatLib.chat("&7Para recalibrar alvo exato: &e/bolsoarcos calibrar arcos|linhas <1-5>");
    ChatLib.chat("&6&m---------------------------------------------");
}
register("tick", function () {
    if (!on) return;
    if (wait > 0) { wait--; return; }
    try {
        if (state === "START") { state = "PREPARE_STRINGS"; wait = 1; return; }
        if (state === "RECOVER") { beginTerrain(terrain || (hasEnoughStringForBatch() ? "bows" : "strings")); return; }
        if (state === "LINE_HOME_CONFIRM") { ChatLib.say(homeToSetHome(HOME_STRINGS_TEMP)); stringsTempReady = true; state = "LINE_HOME_SAVED"; wait = TEMP_HOME_WAIT; return; }
        if (state === "LINE_HOME_SAVED") { if (lineHomeAfter === "REPAIR") repairAndTrash(); else beginTerrain("bows"); return; }
        if (state === "PREPARE_STRINGS") {
            var existingString = findInventoryString(), hotbarTarget = nextStringTarget();
            if (existingString >= 0 && hotbarTarget >= 0 && moveInventoryStringToHotbar(existingString, hotbarTarget)) { wait = TAKE_WAIT; return; }
            checkInventoryFirst();
            return;
        }
        if (state === "BOW_HOME_CONFIRM") { ChatLib.say(homeToSetHome(HOME_BOWS_TEMP)); bowsTempReady = true; state = "BOW_HOME_SAVED"; wait = TEMP_HOME_WAIT; return; }
        if (state === "BOW_HOME_SAVED") { startRepairAndTrash(); return; }
        if (state === "BACK") { key("jump", true); state = "BACK_JUMP_RELEASE"; wait = 2; return; }
        if (state === "BACK_JUMP_RELEASE") { key("jump", false); state = "BACK_READY"; wait = 20; return; }
        if (state === "BACK_READY") { if (replay > 0) { key("sneak", true); key("right", true); state = "REPLAY"; wait = STEP; } else { state = "OPEN"; wait = 3; } return; }
        if (state === "REPLAY") { stopKeys(); replay--; if (replay > 0) { key("sneak", true); key("right", true); wait = STEP; } else { state = "OPEN"; wait = 3; } return; }
        if (state === "MOVE") { stopKeys(); alignStage = 0; state = "OPEN"; wait = 3; return; }
        if (state === "ALIGN") { stopKeys(); state = "OPEN"; wait = 1; return; }
        // Nunca fecha/abre outro baú até o servidor confirmar as duas etapas da troca.
        if (state === "TRANSFER_PLACE") {
            if (pendingTransfer === null) { state = "CHEST"; wait = CHEST_WAIT; return; }
            if (!isTransferContainerStillOpen(pendingTransfer)) { pendingTransfer = null; fail("baú fechou antes de concluir a transferência; retomando com segurança"); return; }
            rawContainerClick(pendingTransfer.destination);
            state = "TRANSFER_CONFIRM";
            wait = TRANSFER_CONFIRM_WAIT;
            return;
        }
        if (state === "TRANSFER_CONFIRM") {
            if (pendingTransfer === null) { state = "CHEST"; wait = CHEST_WAIT; return; }
            var transfer = pendingTransfer;
            var received = transferWasConfirmed(transfer);
            var cursor = Client.getMinecraft().field_71439_g.field_71071_by.field_70462_a;
            // Se o servidor não aceitou a colocação, devolve o cursor ao MESMO baú
            // antes de qualquer navegação. Isso impede o item de desincronizar.
            if (!received && cursor !== null && isTransferContainerStillOpen(transfer)) rawContainerClick(transfer.source);
            pendingTransfer = null;
            state = "CHEST";
            if (received) { transferFailures = 0; if (terrain === "strings" && stringCount() >= MIN_REPAIR_STRING) serverReportedNoString = false; recoveryAttempts = 0; wait = TAKE_WAIT; }
            else { transferFailures++; logArcos("ERRO", "troca não confirmou " + transfer.expectedId + " no slot " + transfer.inventorySlot + " (" + transferFailures + "/3)."); if (transferFailures >= 3) { transferFailures = 0; fail("transferência para a hotbar não foi confirmada pelo servidor"); return; } wait = CHEST_WAIT; }
            return;
        }
        if (state === "BOW_QUICK_CONFIRM") {
            var quickConfirmed = quickBowTransfer !== null && mainBowCount() > quickBowTransfer.before;
            quickBowTransfer = null;
            if (quickConfirmed) { recoveryAttempts = 0; logArcos("COLETA", "arco transferido por Shift-click confirmado."); state = "CHEST"; wait = TAKE_WAIT; return; }
            // Sem confirmação, não presume sucesso: o caminho normal decide o
            // mesmo baú no próximo tick e preserva os itens.
            state = "CHEST";
            wait = CHEST_WAIT;
            return;
        }
        if (state === "HOTBAR_TRANSFER_PLACE") {
            if (pendingTransfer === null) { state = "PREPARE_STRINGS"; wait = TAKE_WAIT; return; }
            if (!isTransferContainerStillOpen(pendingTransfer)) { pendingTransfer = null; fail("inventário mudou antes de organizar a hotbar"); return; }
            rawContainerClick(pendingTransfer.destination);
            state = "HOTBAR_TRANSFER_CONFIRM";
            wait = TRANSFER_CONFIRM_WAIT;
            return;
        }
        if (state === "HOTBAR_TRANSFER_CONFIRM") {
            if (pendingTransfer === null) { state = "PREPARE_STRINGS"; wait = TAKE_WAIT; return; }
            var hotbarTransfer = pendingTransfer;
            var hotbarReceived = transferWasConfirmed(hotbarTransfer);
            var hotbarCursor = Client.getMinecraft().field_71439_g.field_71071_by.field_70462_a;
            if (!hotbarReceived && hotbarCursor !== null && isTransferContainerStillOpen(hotbarTransfer)) rawContainerClick(hotbarTransfer.source);
            pendingTransfer = null;
            if (hotbarReceived) { transferFailures = 0; state = "PREPARE_STRINGS"; wait = TAKE_WAIT; return; }
            transferFailures++;
            logArcos("ERRO", "linha do inventário não entrou na hotbar (" + transferFailures + "/3).");
            if (transferFailures >= 3) { transferFailures = 0; fail("transferência inventário → hotbar não foi confirmada pelo servidor"); return; }
            state = "PREPARE_STRINGS";
            wait = CHEST_WAIT;
            return;
        }
        if (state === "OPEN") {
            if (openChest()) { alignStage = 0; state = "CHEST"; wait = CHEST_WAIT; return; }
            // Um teleporte pode deixar o jogador a poucos pixels entre blocos. Antes
            // de abandonar o baú, testa uma cruz de microajustes agachado e sempre
            // retorna ao ponto original. Não altera a calibração persistida.
            if (alignStage === 0) { alignStage = 1; key("sneak", true); key("right", true); state = "ALIGN"; wait = ALIGN_STEP; return; }
            if (alignStage === 1) { alignStage = 2; key("sneak", true); key("left", true); state = "ALIGN"; wait = ALIGN_STEP * 2; return; }
            if (alignStage === 2) { alignStage = 3; key("sneak", true); key("right", true); state = "ALIGN"; wait = ALIGN_STEP; return; }
            if (alignStage === 3) { alignStage = 4; key("sneak", true); key("forward", true); state = "ALIGN"; wait = ALIGN_STEP; return; }
            if (alignStage === 4) { alignStage = 5; key("sneak", true); key("back", true); state = "ALIGN"; wait = ALIGN_STEP * 2; return; }
            if (alignStage === 5) { alignStage = 6; key("sneak", true); key("forward", true); state = "ALIGN"; wait = ALIGN_STEP; return; }
            fail("não achei o baú na coluna " + (progress[terrain].column + 1) + ", linha " + (progress[terrain].row + 1) + "; confira a home e a calibração.");
            return;
        }
        if (state === "CHEST") {
            var c = Player.getContainer();
            if (!validChest(c)) { fail("baú não abriu na coluna " + (progress[terrain].column + 1) + ", linha " + (progress[terrain].row + 1) + " de " + terrain); return; }
            var target = terrain === "strings" ? nextStringTarget() : nextBowTarget();
            if (target < 0) {
                if (terrain === "strings" && !hasEnoughStringForBatch()) { fail("sem espaço para as " + requiredStringStacks() + " pilhas de linha na hotbar; libere um slot que não seja espada/bloco."); return; }
                if (terrain === "strings") { close(); saveStringHome(bowCount() > 0 && canRepairCurrentBatch() && hasEnoughStringForBatch() ? "REPAIR" : "BOWS"); }
                else if (canRepairCurrentBatch() && hasEnoughStringForBatch()) repairAndTrash();
                else if (!hasEnoughStringForBatch()) { close(); beginTerrain("strings"); }
                else if (terrain === "bows") { close(); advanceChest(); }
                else fail("não encontrei espaço para continuar a preparação do lote.");
                return;
            }
            var source = findChestItem(c, terrain === "strings" ? STRING : BOW);
            if (source < 0) {
                logArcos("BAÚ", "não achei " + (terrain === "strings" ? STRING : BOW) + " no baú aberto; home=" + (terrain === "strings" ? HOME_STRINGS : HOME_BOWS) + "; coluna=" + (progress[terrain].column + 1) + "; linha=" + (progress[terrain].row + 1));
                close(); advanceChest(); return;
            }
            emptyColumns[terrain] = 0;
            if (terrain === "strings") logArcos("COLETA", "linha do baú slot=" + source + " para hotbar=" + (target + 1));
            if (terrain === "bows" && stackAt(target) === null && beginQuickBowTransfer(c, source)) {
                state = "BOW_QUICK_CONFIRM";
                wait = QUICK_BOW_CONFIRM_WAIT;
            } else if (beginChestTransfer(c, source, target, terrain === "strings" ? STRING : BOW)) {
                // Espera entre pegar e colocar; evita que o próximo baú reverta a troca.
                state = "TRANSFER_PLACE";
                wait = TRANSFER_CLICK_WAIT;
            } else wait = CHEST_WAIT;
            return;
        }
        if (state === "REPAIR_WAIT") { goHome(HOME_TRASH); state = "TRASH_JUMP"; wait = WARP_WAIT; return; }
        if (state === "TRASH_JUMP") { key("jump", true); state = "TRASH_JUMP_RELEASE"; wait = 2; return; }
        if (state === "TRASH_JUMP_RELEASE") { key("jump", false); state = "TRASH_DROP"; wait = 20; return; }
        if (state === "TRASH_DROP") { if (dropOneBow()) { wait = DROP_WAIT; return; } if (hasDamagedBow()) { ChatLib.chat("&e[BolsoArcos] Ainda há arcos gastos; voltando ao reparo manual."); beginManualRepair(); return; } chooseCycle(); return; }
        if (state === "MANUAL_REPAIR") { key("jump", true); state = "MANUAL_REPAIR_RELEASE"; wait = 2; return; }
        if (state === "MANUAL_REPAIR_RELEASE") { key("jump", false); state = "MANUAL_REPAIR_USE"; wait = 20; return; }
        if (state === "MANUAL_REPAIR_USE") { if (!hasDamagedBow()) { goHome(HOME_TRASH); state = "TRASH_JUMP"; wait = WARP_WAIT; return; } if (equipDamagedBow() && useManualRepairBlock()) { /* ação enviada: não é travamento só por permanecer neste estado */ stateStallTicks = 0; recoveryAttempts = 0; wait = MANUAL_REPAIR_WAIT; return; } return; }
    } catch (e) { fail("erro " + state + ": " + e); }
});

register("tick", function () {
    if (!on) { lastLoggedState = ""; return; }
    if (state !== lastLoggedState) { lastLoggedState = state; logArcos("ESTADO", "terreno=" + (terrain || "-") + " | linhas=" + (progress.strings.column + 1) + "/" + (progress.strings.row + 1) + " | arcos=" + (progress.bows.column + 1) + "/" + (progress.bows.row + 1)); }
});
// A confirmação do servidor é mais confiável que qualquer leitura visual do inventário.
// Ao faltar linha, interrompe o clique/reparo e reabastece antes de tentar novamente.
register("chat", function (message) {
    var plain = "";
    try { plain = ChatLib.removeFormatting(String(message)); } catch (ignored) { plain = String(message); }
    // O servidor pode entregar códigos § ou & no evento, dependendo do client.
    plain = String(plain).replace(/(?:§|&)[0-9a-fk-or]/gi, "");
    if (!on || !/precisa\s+de\s+mais\s+string/i.test(plain)) return;
    if (state !== "MANUAL_REPAIR_USE" && state !== "REPAIR_WAIT") return;
    serverReportedNoString = true;
    pendingTransfer = null;
    stopKeys(); close();
    ChatLib.chat("&e[BolsoArcos] Linha insuficiente confirmada pelo servidor; voltando aos baús de linha.");
    logArcos("LINHA", "servidor informou falta de String; reabastecendo antes de novo reparo.");
    beginTerrain("strings");
});
register("command", function (first, second, third, fourth, fifth) {
    var parts = []; for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) parts.push(String(arguments[i]));
    var option = parts.join(" ").toLowerCase().trim();
    // Mesmo parser da BolsoVender: compatível com CT 2.2.0, que pode entregar
    // os argumentos juntos ou separados.
    var words = option.split(/\s+/), action = words[0] || "", argument = words[1] || "", extra = words[2] || "", calibrationTerrain = null;
    if (action === "calibrar" && argument === "bau") { action = "calibrarbau"; argument = extra; }
    if (action === "calibrar" && (argument === "arcos" || argument === "linhas")) {
        calibrationTerrain = argument === "arcos" ? "bows" : "strings";
        action = "calibrartarget";
        argument = extra;
    }
    var compact = action.match(/^calibrarbau([1-5])$/);
    if (compact !== null) { action = "calibrarbau"; argument = compact[1]; }
    var compactShort = action.match(/^calibrar([1-5])$/);
    if (compactShort !== null) { action = "calibrarbau"; argument = compactShort[1]; }
    if (action === "calibrarbau") { calibrateLine(parseInt(argument)); return; }
    if (action === "calibrartarget") { calibrateLine(parseInt(argument), calibrationTerrain); return; }
    if (action === "calibrar") { ChatLib.chat("&e[BolsoArcos] Use &f/bolsoarcos calibrar arcos|linhas <1-5>&e."); return; }
    if (option === "calibracoes") { showCalibrations(); return; }
    if (option === "modo manual" || option === "modo comando" || option === "modo fallback") { REPAIR_MODE = option === "modo manual" ? "manual" : (option === "modo comando" ? "command" : "command_then_manual"); ChatLib.chat("&a[BolsoArcos] Modo de reparo desta sessão: " + REPAIR_MODE + "."); return; }
    if (option === "status") { ChatLib.chat("&b[BolsoArcos] " + state + " | linhas=" + (progress.strings.column + 1) + "/" + (progress.strings.row + 1) + " | arcos=" + (progress.bows.column + 1) + "/" + (progress.bows.row + 1) + " | arcos inv=" + mainBowCount() + "/" + MIN_BOWS_TO_REPAIR + " | fio=" + stringCount()); ChatLib.chat("&7Home de linhas: &f" + HOME_STRINGS + " &7| próximo slot hotbar: &f" + (nextStringTarget() + 1)); return; }
    if (option === "inicio" || option === "reiniciar" || option === "reset") { if (on) fail("reinício solicitado."); progress = { strings: { column: 0, row: 0 }, bows: { column: 0, row: 0 } }; save(); ChatLib.chat("&a[BolsoArcos] Progresso dos dois terrenos zerado."); return; }
    if (option === "inicio linhas") { progress.strings = { column: 0, row: 0 }; save(); ChatLib.chat("&a[BolsoArcos] Progresso das linhas zerado."); return; }
    if (option === "inicio arcos") { progress.bows = { column: 0, row: 0 }; save(); ChatLib.chat("&a[BolsoArcos] Progresso dos arcos zerado."); return; }
    if (option === "help" || option === "ajuda") { showHelp(); return; }
    if (option === "start" || option === "iniciar" || option === "ligar") { if (on) ChatLib.chat("&e[BolsoArcos] Já está ligada."); else { resetProgressForNewRun(); terrain = null; bowsTempReady = false; stringsTempReady = false; serverReportedNoString = false; recoveryAttempts = 0; sessionStartedAt = Date.now(); stats = { repairCycles: 0, droppedBows: 0 }; on = true; state = "START"; wait = 2; ChatLib.chat("&a[BolsoArcos] Iniciada do primeiro baú."); } return; }
    if (option === "stop" || option === "parar" || option === "desligar") { if (on) fail("desligada pelo comando."); else ChatLib.chat("&e[BolsoArcos] Já está desligada."); return; }
    if (option !== "") { ChatLib.chat("&eUse /bolsoarcos help"); return; }
    if (on) { fail("desligada."); return; }
    resetProgressForNewRun();
    terrain = null;
    bowsTempReady = false;
    stringsTempReady = false;
    sessionStartedAt = Date.now(); stats = { repairCycles: 0, droppedBows: 0 }; on = true; state = "START"; wait = 2; ChatLib.chat("&a[BolsoArcos] Iniciada do primeiro baú.");
}).setName("bolsoarcos");

// Nunca deixa warp, baú ou reparação parados indefinidamente. A parada é
// segura: não descarta arcos nem limpa a mochila ao detectar o timeout.
register("tick", function () {
    if (!on) { observedState = "IDLE"; stateStallTicks = 0; return; }
    if (state === observedState) stateStallTicks++; else { observedState = state; stateStallTicks = 0; }
    if (state !== "IDLE" && stateStallTicks >= STATE_TIMEOUT_TICKS) fail("estado " + state + " travado por " + Math.round(STATE_TIMEOUT_TICKS / 20) + "s; itens preservados.");
});
