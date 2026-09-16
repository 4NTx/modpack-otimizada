// BolsoVender: baú -> home da venda -> ataque esquerdo na placa -> próximo baú.
ChatLib.chat("&a[BolsoVender] Módulo carregado. Use &f/bolsovender&a para iniciar.");
function yaml(t) { var r = {}, p = [r]; String(t || "").split(/\r?\n/).forEach(function (l) { if (/^\s*$|^\s*#/.test(l)) return; var m = l.match(/^(\s*)([^:#][^:]*):\s*(.*)$/); if (!m) return; var d = Math.floor(m[1].length / 2), k = m[2].trim(), v = m[3].trim(); while (p.length > d + 1) p.pop(); var q = p[d] || r; if (!v) { q[k] = {}; p[d + 1] = q[k]; } else q[k] = v.replace(/^['"]|['"]$/g, ""); }); return r; }
var C = yaml(FileLib.read("BolsoVender", "config.yml") || "");
function V(section, key, fallback) { return C[section] && C[section][key] !== undefined ? C[section][key] : fallback; }
function logVender(kind, message) {
    try {
        var file = kind === "ERRO" ? "data/error-log.txt" : "data/diagnostic-log.txt";
        var old = FileLib.read("BolsoVender", file) || "";
        if (old.length > 50000) old = old.substring(old.length - 36000);
        FileLib.write("BolsoVender", file, old + "[" + new Date().toLocaleTimeString() + "] [" + kind + "] [" + state + "] " + message + "\n");
    } catch (ignored) { }
}

var sales = C.sales || {};
var names = [];
for (var n in sales) if (sales.hasOwnProperty(n) && sales[n].item && sales[n].home) names.push(n);
// Lista separada das vendas: estes itens são removidos diretamente do baú e
// jogados no chão, sem ocupar mochila nem tentar acionar uma placa.
var discardItems = String(V("discard", "items", "")).split(",").map(function (id) { return id.trim(); }).filter(function (id) { return id.length > 0; });

var home = V("homes", "storage", "/home baus");
// Esta home é sobrescrita antes de cada venda, para voltar diretamente ao baú.
// Deve ser uma home exclusiva da macro; não use uma home importante aqui.
var returnHome = V("homes", "temporaryReturn", "/home bolsovender");
var hideCommand = V("general", "hideCommand", "/esconder");
var emptyChestsBeforeFarm = Math.max(0, parseInt(V("automation", "emptyChestsBeforeFarm", 10)) || 0);
var resumeFarmCommand = V("automation", "resumeFarmCommand", "/bolsofarm");
var resetFarmBeforeStart = String(V("automation", "resetFarmBeforeStart", "true")).toLowerCase() !== "false";
var sellInventoryBeforeFarm = String(V("automation", "sellInventoryBeforeFarm", "true")).toLowerCase() !== "false";
var pendingFarmStartCommand = null;
var pendingFarmStartTicks = 0;
var finishFarmAfterSelling = false;
var finishFarmReason = "";
var max = Math.max(1, parseInt(V("storage", "maxColumns", 128)));
var step = Math.max(1, parseInt(V("storage", "stepTicks", 15)));
var warp = Math.max(20, parseInt(V("selling", "warpWaitTicks", 55)));
var chestWait = Math.max(2, parseInt(V("selling", "chestWaitTicks", 10)));
var chestOpenRetries = Math.max(1, parseInt(V("selling", "chestOpenRetries", 4)) || 4);
var sellWait = Math.max(2, parseInt(V("selling", "sellWaitTicks", 12)));
var attacks = Math.max(1, parseInt(V("selling", "signAttacksPerStack", 1)));
var attackHoldTicks = Math.max(1, parseInt(V("selling", "signAttackHoldTicks", 8)));
var autoClickSelling = String(V("selling", "autoClickSelling", "true")).toLowerCase() !== "false";
var takeStacksPerTick = Math.max(1, parseInt(V("selling", "takeStacksPerTick", 2)) || 2);
var takeConfirmTicks = Math.max(2, parseInt(V("selling", "takeConfirmTicks", 5)) || 5);
var takeConfirmRetries = Math.max(1, parseInt(V("selling", "takeConfirmRetries", 4)) || 4);
var discardStacksPerTick = Math.max(1, parseInt(V("discard", "stacksPerTick", 1)) || 1);
var discardConfirmTicks = Math.max(2, parseInt(V("discard", "confirmTicks", 6)) || 6);
var discardConfirmMaxRetries = Math.max(1, parseInt(V("discard", "confirmRetries", 5)) || 5);
var maxSellNoProgress = Math.max(1, parseInt(V("selling", "maxNoProgressChecks", 5)) || 5);
var stateTimeoutTicks = Math.max(200, parseInt(V("safety", "stateTimeoutSeconds", 45)) * 20 || 900);
var temporaryHomeWait = Math.max(5, parseInt(V("storage", "temporaryHomeWaitTicks", 25)) || 25);
var pitch = String(V("storage", "rowPitch", "-53,-34,0,34,53")).split(",").map(parseFloat); while (pitch.length < 5) pitch.push(0);
try { var savedPitch = JSON.parse(FileLib.read("BolsoVender", "data/chest-pitch.json") || "null"); if (savedPitch && savedPitch.length === 5) pitch = savedPitch; } catch (e) { }
var on = false;
var state = "IDLE";
var chestOpenAttempt = 0;
var wait = 0;
var col = 0;
var row = 0;
var back = 0;
var sale = null;
var left = 0;
var aims = {};
var takeSlots = [];
var takeIndex = 0;
var takeAttempt = null;
var takeAttemptRetries = 0;
var discardSlots = [];
var discardIndex = 0;
var discardAttempt = null;
var discardConfirmRetries = 0;
var discardBlockedSlots = {};
var discardBlockedChestKey = "";
var chestContentKey = "";
var chestHadContents = false;
var lastSetHomeCommand = "";
var lastSetHomeAt = 0;
var pendingSetHomeCommand = null;
var pendingSetHomeTicks = 0;
var pendingSetHomeName = null;
var pendingSetHomeAfter = null;
var temporaryHomeReady = false;
var consecutiveEmptyChests = 0;
var saleCountBefore = 0;
var saleNoProgressChecks = 0;
var observedState = "IDLE";
var stateStallTicks = 0;
var lastLoggedState = "";
var sessionStartedAt = 0;
var stats = { soldItems: 0, takenStacks: 0, discardedStacks: 0, chestRetries: 0 };
function sessionDuration() { var total = sessionStartedAt <= 0 ? 0 : Math.floor((Date.now() - sessionStartedAt) / 1000), minutes = Math.floor(total / 60), seconds = total % 60; return minutes + "m " + seconds + "s"; }
function showSessionStats() { if (sessionStartedAt <= 0) return; ChatLib.chat("&8&m------------------------------"); ChatLib.chat("&e[BolsoVender] &fSessão encerrada &7(" + sessionDuration() + ")"); ChatLib.chat("&7Itens vendidos: &a" + stats.soldItems + " &7| Pilhas retiradas: &a" + stats.takenStacks + " &7| Pilhas descartadas: &a" + stats.discardedStacks); ChatLib.chat("&7Retentativas de baú: &e" + stats.chestRetries + " &7| Último ponto: &f" + (col + 1) + "/" + (row + 1)); ChatLib.chat("&8&m------------------------------"); }
try { aims = JSON.parse(FileLib.read("BolsoVender", "data/shop-aims.json") || "{}"); } catch (e) { }
function save() {
    try { FileLib.write("BolsoVender", "data/progress.json", JSON.stringify({ column: col, row: row })); } catch (e) { }
}

function key(name, pressed) {
    try {
        var settings = Client.getMinecraft().field_71474_y;
        var binding = name === "sneak" ? settings.field_74311_E :
            (name === "jump" ? settings.field_74314_A :
                (name === "attack" ? settings.field_74312_F : settings.field_74366_z));
        Java.type("net.minecraft.client.settings.KeyBinding").func_74510_a(binding.func_151463_i(), pressed);
    } catch (e) { }
}

function stop() {
    key("sneak", false);
    key("right", false);
    key("jump", false);
    key("attack", false);
}

function fail(reason, expectedStop) {
    var context = " | estado=" + state + " | coluna=" + (col + 1) + " | linha=" + (row + 1) + " | item=" + (sale || "-");
    on = false;
    state = "IDLE";
    stop();
    logVender(expectedStop === true ? "INFO" : "ERRO", reason + " | coluna=" + (col + 1) + " | linha=" + (row + 1) + " | item=" + (sale || "-"));
    ChatLib.chat((expectedStop === true ? "&e" : "&c") + "[BolsoVender] Parada: " + reason + context);
    showSessionStats();
}
function finishAndResumeFarm(reason) {
    on = false;
    state = "IDLE";
    stop();
    ChatLib.chat("&a[BolsoVender] " + (reason || (consecutiveEmptyChests + " baús vazios seguidos")) + "; venda encerrada e BolsoFarm iniciada.");
    try {
        var command = String(resumeFarmCommand || "").replace(/^\s*\//, "").trim();
        if (command.length <= 0) return;
        if (resetFarmBeforeStart) {
            ChatLib.command("bolsofarm inicio", true);
            pendingFarmStartCommand = command;
            pendingFarmStartTicks = 4;
            ChatLib.chat("&7[BolsoVender] BolsoFarm será iniciada do começo.");
        } else ChatLib.command(command, true);
    } catch (e) { ChatLib.chat("&c[BolsoVender] Não consegui iniciar a BolsoFarm: " + e); }
}

function finishAfterSellingInventory(reason) {
    if (sellInventoryBeforeFarm && inventorySale() !== null) {
        finishFarmAfterSelling = true;
        finishFarmReason = reason;
        ChatLib.chat("&e[BolsoVender] Vendendo os últimos itens do inventário antes de iniciar a BolsoFarm.");
        goSell(true);
        return;
    }
    finishAndResumeFarm(reason);
}

register("tick", function () {
    if (pendingFarmStartCommand === null) return;
    if (--pendingFarmStartTicks > 0) return;
    var command = pendingFarmStartCommand;
    pendingFarmStartCommand = null;
    try { ChatLib.command(command, true); } catch (e) { ChatLib.chat("&c[BolsoVender] Não consegui iniciar a BolsoFarm: " + e); }
});

function aimChest() {
    var player = Client.getMinecraft().field_71439_g;
    player.field_70177_z = 180;
    player.field_70125_A = pitch[row];
    player.field_70126_B = 180;
    player.field_70127_C = pitch[row];
}

function open() {
    aimChest();
    var minecraft = Client.getMinecraft();
    minecraft.field_71476_x = minecraft.field_71439_g.func_174822_a(5, 1);
    minecraft.func_147121_ag();
}

function close() {
    try { Client.getMinecraft().func_147108_a(null); } catch (e) { }
}
function isSellableStack(name, item) { if (item === null || item.getRegistryName() !== sales[name].item) return false; var minimum = Math.max(1, parseInt(sales[name].minimumStackSize) || 1); return item.getStackSize() >= minimum; }
function found(c) { var z = c.getSize() - 36; for (var i = 0; i < names.length; i++)for (var j = 0; j < z; j++) { var it = c.getStackInSlot(j); if (isSellableStack(names[i], it)) return { name: names[i], slot: j }; } return null; }
function saleForItem(id) { for (var i = 0; i < names.length; i++)if (sales[names[i]].item === id) return names[i]; return null; }
function shouldDiscard(id) { return discardItems.indexOf(id) !== -1; }
function dropChestStack(containerSlot) { var player = Client.getMinecraft().field_71439_g; Client.getMinecraft().field_71442_b.func_78753_a(player.field_71069_bz.field_75152_c, containerSlot, 1, 4, player); }
function inventorySize() { return Math.min(36, Player.getInventory().getSize()); }
function inventorySale() { var inv = Player.getInventory(); for (var i = 0; i < names.length; i++)for (var j = 0; j < inventorySize(); j++) { var it = inv.getStackInSlot(j); if (isSellableStack(names[i], it)) return names[i]; } return null; }
function inventoryItemCount(id) { var inv = Player.getInventory(), total = 0; for (var i = 0; i < inventorySize(); i++) { var item = inv.getStackInSlot(i); if (item !== null && item.getRegistryName() === id) total += item.getStackSize(); } return total; }
function hasFreeSlot() { var inv = Player.getInventory(); for (var i = 0; i < inventorySize(); i++)if (inv.getStackInSlot(i) === null) return true; return false; }
function canAcceptStack(stack) { if (stack === null) return false; var inv = Player.getInventory(), id = stack.getRegistryName(); for (var i = 0; i < inventorySize(); i++) { var current = inv.getStackInSlot(i); if (current === null) return true; if (current.getRegistryName() === id && current.getStackSize() < 64) return true; } return false; }
function setHomeCommandFromHomeCommand(homeCommand) { var match = String(homeCommand).match(/^\s*\/home\s+(.+?)\s*$/i); return match === null ? null : "/sethome " + match[1]; }
function goHome(command) { ChatLib.chat("&b[BolsoVender] &7Indo para: &f" + command); ChatLib.say(command); }
function startSellingWarp() { key("attack", false); key("sneak", false); ChatLib.say(hideCommand); goHome(sales[sale].home); state = "SHOP_JUMP"; wait = warp; }
function goSell(fromChest) {
    var previousSale = sale;
    sale = inventorySale();
    if (sale === null) { returnChest(); return; }
    if (sale !== previousSale || fromChest) { saleCountBefore = inventoryItemCount(sales[sale].item); saleNoProgressChecks = 0; }
    // Repetir a venda acontece já dentro da loja. Não pode sobrescrever a home
    // temporária ali, ou o retorno apontaria para a placa em vez do baú.
    if (!fromChest) { startSellingWarp(); return; }
    save();
    var command = setHomeCommandFromHomeCommand(returnHome);
    if (command === null) {
        // Configuração inválida não interrompe a macro: mantém o retorno antigo.
        temporaryHomeReady = false;
        ChatLib.chat("&e[BolsoVender] homes.temporaryReturn inválida; usando /home baus e caminhada como antes.");
        startSellingWarp();
        return;
    }
    // O servidor pede o mesmo /sethome duas vezes quando a home já existe.
    // Só teleporta para vender depois da confirmação, evitando salvar a home tarde demais.
    lastSetHomeCommand = command;
    lastSetHomeAt = new Date().getTime();
    ChatLib.say(command);
    pendingSetHomeCommand = command;
    pendingSetHomeName = "retorno do baú";
    pendingSetHomeAfter = "SELL_AFTER_CHEST_HOME";
    pendingSetHomeTicks = 100;
    state = "CHEST_HOME_SAVE";
    wait = 0;
}
function setSaleHome(name) { var command = String(sales[name].home).replace(/^\s*\/home\s+/i, "/sethome "); if (command === String(sales[name].home)) { ChatLib.chat("&c[BolsoVender] A home de " + name + " deve estar no formato /home nome."); return false; } lastSetHomeCommand = command; lastSetHomeAt = new Date().getTime(); ChatLib.say(command); pendingSetHomeCommand = command; pendingSetHomeName = name; pendingSetHomeTicks = 100; ChatLib.chat("&7[BolsoVender] /sethome enviado (1/2): " + name + "; aguardando resposta do servidor."); return true; }
function confirmSaleHome() {
    if (pendingSetHomeCommand === null) return false;
    ChatLib.say(pendingSetHomeCommand);
    ChatLib.chat("&a[BolsoVender] /sethome reenviado (2/2): " + pendingSetHomeName);
    var after = pendingSetHomeAfter;
    pendingSetHomeCommand = null;
    pendingSetHomeName = null;
    pendingSetHomeAfter = null;
    if (after === "SELL_AFTER_CHEST_HOME") {
        temporaryHomeReady = true;
        state = "CHEST_HOME_SAVED";
        wait = temporaryHomeWait;
    }
    return true;
}
function captureShopAim(name) {
    try {
        var minecraft = Client.getMinecraft();
        var player = minecraft.field_71439_g;
        var aim = { yaw: player.field_70177_z, pitch: player.field_70125_A };
        var hit = minecraft.field_71476_x;

        if (hit === null || hit === undefined) {
            hit = player.func_174822_a(5.0, 1.0);
        }
        if (hit === null || hit === undefined) {
            ChatLib.chat("&c[BolsoVender] Mire diretamente na placa, a até 5 blocos, e calibre de novo.");
            return false;
        }

        // getBlockPos é público no 1.8.9; os campos internos variam entre builds.
        var pos = hit.func_178782_a();
        if (pos === null || pos === undefined) {
            ChatLib.chat("&c[BolsoVender] O alvo não é uma placa/bloco. Mire no centro da placa.");
            return false;
        }
        aim.block = {
            x: Number(pos.func_177958_n()),
            y: Number(pos.func_177956_o()),
            z: Number(pos.func_177952_p()),
            side: String(hit.field_178784_b)
        };
        if (isNaN(aim.block.x) || isNaN(aim.block.y) || isNaN(aim.block.z)) {
            ChatLib.chat("&c[BolsoVender] Não consegui ler as coordenadas da placa. Mire nela e tente novamente.");
            return false;
        }

        aims[name] = aim;
        FileLib.write("BolsoVender", "data/shop-aims.json", JSON.stringify(aims));
        return true;
    } catch (error) {
        ChatLib.chat("&c[BolsoVender] Falha ao ler a placa: " + error);
        return false;
    }
}
function aimShop(name) {
    var aim = aims[name];
    return aim !== undefined && aim !== null && aim.block !== undefined &&
        !isNaN(aim.block.x) && !isNaN(aim.block.y) && !isNaN(aim.block.z);
}

function attackShop(name) {
    var aim = aims[name];
    var minecraft = Client.getMinecraft();
    if (!aimShop(name)) return false;
    try {
        var BlockPos = Java.type("net.minecraft.util.BlockPos");
        var EnumFacing = Java.type("net.minecraft.util.EnumFacing");
        var Vec3 = Java.type("net.minecraft.util.Vec3");
        var MovingObjectPosition = Java.type("net.minecraft.util.MovingObjectPosition");
        var pos = new BlockPos(aim.block.x, aim.block.y, aim.block.z);
        var side = EnumFacing.valueOf(String(aim.block.side).toUpperCase());
        minecraft.field_71476_x = new MovingObjectPosition(new Vec3(aim.block.x + 0.5, aim.block.y + 0.5, aim.block.z + 0.5), side, pos);
        minecraft.func_147116_af();
        return true;
    } catch (error) {
        ChatLib.chat("&c[BolsoVender] Falha no ataque da placa: " + error);
        return false;
    }
}
function next() { row++; save(); if (row < 5) { state = "OPEN"; wait = 2; return; } row = 0; col++; save(); if (col >= max) { finishAfterSellingInventory("fim das " + max + " colunas de baús"); return; } key("sneak", true); key("right", true); state = "MOVE"; wait = step; }
function returnChest() {
    // Depois da primeira venda, esta home aponta exatamente para o baú atual.
    // Antes disso (por exemplo, se iniciou com o inventário cheio), preserva o fluxo antigo.
    goHome(temporaryHomeReady ? returnHome : home);
    back = temporaryHomeReady ? 0 : col;
    state = "BACK";
    wait = warp;
}
register("tick", function () {
    if (!on) return; if (wait > 0) { wait--; return; } try {
        if (state === "START") { goHome(home); back = col; state = "BACK"; wait = warp; return; }
        if (state === "BACK") { key("attack", false); key("jump", true); state = "BACK_JUMP_RELEASE"; wait = 2; return; }
        if (state === "BACK_JUMP_RELEASE") { key("jump", false); state = "BACK_READY"; wait = 20; return; }
        if (state === "BACK_READY") { if (back > 0) { key("sneak", true); key("right", true); state = "REPLAY"; wait = step; } else { state = "OPEN"; wait = 3; } return; }
        if (state === "REPLAY") { stop(); back--; if (back > 0) { key("sneak", true); key("right", true); wait = step; } else { state = "OPEN"; wait = 3; } return; }
        if (state === "OPEN") { open(); state = "CHEST"; wait = chestWait; return; }
        if (state === "CHEST") {
            var c = Player.getContainer();
            if (c === null || c.getSize() < 63) {
                if (chestOpenAttempt < chestOpenRetries) {
                    chestOpenAttempt++;
                    stats.chestRetries++;
                    stop();
                    ChatLib.chat("&e[BolsoVender] Baú não abriu; retorno e nova tentativa " + chestOpenAttempt + "/" + chestOpenRetries + ".");
                    // Antes da primeira venda ainda não existe home temporária:
                    // nesse caso volta pela home principal em vez de parar.
                    goHome(temporaryHomeReady ? returnHome : home);
                    state = "CHEST_RETRY_WARP";
                    wait = warp;
                    return;
                }
                fail("baú não abriu em " + (col + 1) + "/" + (row + 1) + " após " + chestOpenAttempt + " tentativas.");
                return;
            }
            chestOpenAttempt = 0;
            // Limpa primeiro as pilhas marcadas para descarte. Depois reabre a
            // mesma leitura do baú para decidir se vende algum item restante.
            var currentChestKey = col + ":" + row;
            if (discardBlockedChestKey !== currentChestKey) { discardBlockedChestKey = currentChestKey; discardBlockedSlots = {}; }
            if (chestContentKey !== currentChestKey) { chestContentKey = currentChestKey; chestHadContents = false; }
            discardSlots = []; discardIndex = 0; discardAttempt = null; discardConfirmRetries = 0;
            for (var ds = 0; ds < c.getSize() - 36; ds++) { var di = c.getStackInSlot(ds); if (di !== null && (shouldDiscard(di.getRegistryName()) || saleForItem(di.getRegistryName()) !== null)) chestHadContents = true; if (di !== null && shouldDiscard(di.getRegistryName()) && !discardBlockedSlots[ds]) discardSlots.push(ds); }
            if (discardSlots.length > 0) { state = "DISCARD_CHEST"; wait = 1; return; }
            var f = found(c); if (!f) { if (chestHadContents) consecutiveEmptyChests = 0; else consecutiveEmptyChests++; close(); if (emptyChestsBeforeFarm > 0 && consecutiveEmptyChests >= emptyChestsBeforeFarm) { finishAfterSellingInventory(consecutiveEmptyChests + " baús vazios seguidos"); return; } if (hasFreeSlot()) { next(); } else { goSell(true); } return; } consecutiveEmptyChests = 0; takeSlots = []; takeIndex = 0; for (var ts = 0; ts < c.getSize() - 36; ts++) { var ti = c.getStackInSlot(ts), saleName = ti === null ? null : saleForItem(ti.getRegistryName()); if (saleName !== null && isSellableStack(saleName, ti)) takeSlots.push(ts); } state = "TAKE"; wait = 1; return;
        }
        if (state === "CHEST_RETRY_WARP") { key("jump", true); state = "CHEST_RETRY_JUMP_RELEASE"; wait = 2; return; }
        if (state === "CHEST_RETRY_JUMP_RELEASE") { key("jump", false); state = "OPEN"; wait = 20; return; }
        if (state === "DISCARD_CHEST") { var discardContainer = Player.getContainer(); while (discardIndex < discardSlots.length) { var discardSlot = discardSlots[discardIndex], discardStack = discardContainer.getStackInSlot(discardSlot); if (discardStack === null || !shouldDiscard(discardStack.getRegistryName())) { discardIndex++; continue; } discardAttempt = { slot: discardSlot, id: discardStack.getRegistryName(), size: discardStack.getStackSize() }; discardConfirmRetries = 0; dropChestStack(discardSlot); state = "DISCARD_CONFIRM"; wait = discardConfirmTicks; return; } state = "CHEST"; wait = 3; return; }
        if (state === "DISCARD_CONFIRM") { var confirmContainer = Player.getContainer(), remainingDiscard = discardAttempt === null ? null : confirmContainer.getStackInSlot(discardAttempt.slot); var unchangedDiscard = remainingDiscard !== null && remainingDiscard.getRegistryName() === discardAttempt.id && remainingDiscard.getStackSize() === discardAttempt.size; if (unchangedDiscard && discardConfirmRetries < discardConfirmMaxRetries) { discardConfirmRetries++; dropChestStack(discardAttempt.slot); wait = discardConfirmTicks; return; } if (unchangedDiscard) { discardBlockedSlots[discardAttempt.slot] = true; ChatLib.chat("&e[BolsoVender] Não consegui descartar " + discardAttempt.id + " neste baú; seguindo sem travar."); } else stats.discardedStacks++; discardAttempt = null; discardIndex++; state = "DISCARD_CHEST"; wait = 1; return; }
        if (state === "TAKE") { var takeContainer = Player.getContainer(); while (takeIndex < takeSlots.length) { var takeSlot = takeSlots[takeIndex], takeStack = takeContainer.getStackInSlot(takeSlot), takeSale = takeStack === null ? null : saleForItem(takeStack.getRegistryName()); if (takeStack === null || takeSale === null || !isSellableStack(takeSale, takeStack)) { takeIndex++; continue; } if (!canAcceptStack(takeStack)) { close(); goSell(true); return; } takeAttempt = { slot: takeSlot, id: takeStack.getRegistryName(), size: takeStack.getStackSize() }; takeAttemptRetries = 0; takeContainer.click(takeSlot, true); state = "TAKE_CONFIRM"; wait = takeConfirmTicks; return; } close(); if (hasFreeSlot()) { next(); } else { goSell(true); } return; }
        if (state === "TAKE_CONFIRM") { var confirmTakeContainer = Player.getContainer(), remainingTake = takeAttempt === null ? null : confirmTakeContainer.getStackInSlot(takeAttempt.slot); var takeChanged = remainingTake === null || remainingTake.getRegistryName() !== takeAttempt.id || remainingTake.getStackSize() < takeAttempt.size; if (!takeChanged && takeAttemptRetries < takeConfirmRetries) { takeAttemptRetries++; confirmTakeContainer.click(takeAttempt.slot, true); wait = takeConfirmTicks; return; } if (!takeChanged) { ChatLib.chat("&e[BolsoVender] Não consegui retirar " + takeAttempt.id + " deste baú; seguindo sem travar."); } else stats.takenStacks++; takeAttempt = null; takeIndex++; state = "TAKE"; wait = 1; return; }
        if (state === "CHEST_HOME_SAVE") return;
        if (state === "CHEST_HOME_SAVED") { startSellingWarp(); return; }
        if (state === "SHOP_JUMP") { key("jump", true); state = "SHOP_JUMP_RELEASE"; wait = 2; return; }
        if (state === "SHOP_JUMP_RELEASE") { key("jump", false); state = "SHOP"; wait = 20; return; }
        if (state === "SHOP") { if (!aimShop(sale)) { fail("calibre a placa: /bolsovender calibrar " + sale); return; } left = attacks; key("sneak", false); key("attack", false); state = "SNEAK_WAIT"; wait = 5; return; }
        if (state === "SNEAK_WAIT") { key("sneak", false); aimShop(sale); state = "HIT"; wait = 1; return; }
        if (state === "HIT") { aimShop(sale); key("attack", false); attackShop(sale); state = "ATTACK_HOLD"; wait = attackHoldTicks; return; }
        if (state === "ATTACK_HOLD") { state = "RELEASE"; wait = 1; return; }
        if (state === "RELEASE") { if (--left > 0) { state = "SNEAK_WAIT"; wait = 3; } else { key("sneak", false); state = "SOLD"; wait = sellWait; } return; }
        if (state === "SOLD") { var soldNow = inventoryItemCount(sales[sale].item); if (soldNow >= saleCountBefore) saleNoProgressChecks++; else { stats.soldItems += saleCountBefore - soldNow; saleNoProgressChecks = 0; } saleCountBefore = soldNow; if (saleNoProgressChecks >= maxSellNoProgress) { fail("placa não confirmou a venda após " + maxSellNoProgress + " tentativas; itens preservados no inventário."); return; } if (inventorySale() !== null) { goSell(false); } else if (finishFarmAfterSelling) { var finalReason = finishFarmReason; finishFarmAfterSelling = false; finishFarmReason = ""; finishAndResumeFarm(finalReason); } else { returnChest(); } return; }
        if (state === "MOVE") { stop(); state = "OPEN"; wait = 3; return; }
    } catch (e) { fail("erro " + state + ": " + e); }
});
// Nenhuma transição pode permanecer para sempre: conserva itens/progresso e
// para com uma causa clara em vez de deixar o personagem parado.
register("tick", function () {
    if (!on) { observedState = "IDLE"; stateStallTicks = 0; return; }
    if (state === observedState) stateStallTicks++; else { observedState = state; stateStallTicks = 0; }
    if (stateStallTicks >= stateTimeoutTicks) fail("estado " + state + " travado por " + Math.round(stateTimeoutTicks / 20) + "s; itens preservados.");
});
function showSellHelp() {
    ChatLib.chat("&6&m--------------- &eBolsoVender &6&m---------------");
    ChatLib.chat("&e/bolsovender&7: inicia ou para a macro.");
    ChatLib.chat("&e/bolsovender start|stop|status|help&7: comandos padronizados.");
    ChatLib.chat("&e/bolsovender inicio&7: zera o progresso; próximo início é o baú 0.");
    ChatLib.chat("&e/bolsovender status&7: mostra estado, baú e item atual.");
    ChatLib.chat("&7Antes de vender, atualiza &fhomes.temporaryReturn&7 e retorna direto ao baú atual.");
    ChatLib.chat("&e/bolsovender calibrar bau <1-5>&7: calibra a altura de uma linha de baús.");
    ChatLib.chat("&e/bolsovender calibrar <nome>&7: salva placa e executa /sethome duas vezes.");
    ChatLib.chat("&e/bolsovender calibracoes&7: lista todas as vendas e o que já foi calibrado.");
    ChatLib.chat("&7Configure vendas em &fsales&7 e limpezas de baú em &fdiscard&7 no config.yml.");
    ChatLib.chat("&6&m---------------------------------------------");
}
function startSeller() {
    if (on) { fail("desligada.", true); return; }
    if (!names.length) { fail("nenhuma venda configurada."); return; }
    var saved = {};
    try { saved = JSON.parse(FileLib.read("BolsoVender", "data/progress.json") || "{}"); } catch (e) { }
    col = Math.max(0, parseInt(saved.column) || 0);
    row = Math.max(0, Math.min(4, parseInt(saved.row) || 0));
    consecutiveEmptyChests = 0;
    chestOpenAttempt = 0;
    sessionStartedAt = Date.now();
    stats = { soldItems: 0, takenStacks: 0, discardedStacks: 0, chestRetries: 0 };
    on = true;
    logVender("INFO", "macro iniciada; coluna=" + (col + 1) + ", linha=" + (row + 1));
    ChatLib.say(V("general", "menuOffCommand", "/menuloja off"));
    if (inventorySale() !== null && !hasFreeSlot()) {
        ChatLib.chat("&e[BolsoVender] Inventário cheio; vendendo antes de buscar mais itens.");
        goSell(false);
    } else {
        state = "START";
        wait = 2;
        ChatLib.chat("&a[BolsoVender] Iniciada.");
    }
}
register("command", function (first, second, third) {
    // Dependendo da versão do ChatTriggers, os argumentos chegam em uma única
    // string ou separados. Junta os dois formatos antes de interpretar.
    var rawWords = [];
    for (var rawIndex = 0; rawIndex < arguments.length; rawIndex++) {
        if (arguments[rawIndex] !== undefined && arguments[rawIndex] !== null) rawWords.push(String(arguments[rawIndex]));
    }
    var words = rawWords.join(" ").toLowerCase().trim().split(/\s+/);
    var action = words[0] || "";
    var argument = words[1] || "";
    var extra = words[2] || "";

    if (action === "calibrar") ChatLib.chat("&7[BolsoVender] Recebi calibração: " + argument + (extra ? " " + extra : ""));

    if (action === "help" || action === "ajuda") { showSellHelp(); return; }
    if (action === "start" || action === "iniciar" || action === "ligar") { if (on) ChatLib.chat("&e[BolsoVender] Já está ligada."); else startSeller(); return; }
    if (action === "stop" || action === "parar" || action === "desligar") { if (on) fail("desligada pelo comando.", true); else ChatLib.chat("&e[BolsoVender] Já está desligada."); return; }
    if (action === "inicio" || action === "reset" || action === "reiniciar") { ChatLib.command("bolsovenderinicio", true); return; }
    if (action === "calibracoes") { ChatLib.command("bolsovendercalibracoes", true); return; }
    if (action === "status") { ChatLib.chat("&b[BolsoVender] " + state + " | " + (col + 1) + "/" + (row + 1) + " | " + (sale || "-")); return; }

    if (action === "calibrar" && argument === "bau") { action = "calibrarbau"; argument = extra; }
    // "calibrar linha" é o formato principal. Também aceita o formato antigo
    // "calibrar venda linha" para configurações já anotadas pelo jogador.
    if (action === "calibrar" && argument === "venda") { argument = extra; }
    var compact = action.match(/^calibrarbau([1-5])$/);
    if (compact !== null) { action = "calibrarbau"; argument = compact[1]; }

    if (action === "calibrarbau") {
        var line = parseInt(argument);
        if (isNaN(line) || line < 1 || line > 5) { ChatLib.chat("&cUse: /bolsovender calibrar bau <1-5>"); return; }
        pitch[line - 1] = Client.getMinecraft().field_71439_g.field_70125_A;
        FileLib.write("BolsoVender", "data/chest-pitch.json", JSON.stringify(pitch));
        ChatLib.chat("&a[BolsoVender] Linha " + line + " calibrada.");
        return;
    }
    if (action === "calibrar") {
        if (!sales[argument]) { ChatLib.chat("&c[BolsoVender] Venda não existe no config.yml: " + argument); return; }
        if (!captureShopAim(argument)) return;
        setSaleHome(argument);
        ChatLib.chat("&a[BolsoVender] Placa e home calibradas: " + argument);
        return;
    }
    if (action !== "") { ChatLib.chat("&e[BolsoVender] Comando não reconhecido. Use &f/bolsovender help&e."); return; }
    startSeller();
}).setName("bolsovender");

register("command", function () { if (on) { fail("reinício solicitado.", true); } col = 0; row = 0; save(); ChatLib.chat("&a[BolsoVender] Progresso zerado: próximo início será no baú 0 (coluna 1, linha 1)."); }).setName("bolsovenderinicio");
// Durante a venda, Shift fica sempre desligado e o autoclick só ataca o bloco
// salvo na calibração; não há giro nem pacote de movimento manual.
register("tick", function () {
    if (!on || sale === null) return;
    if (state === "SHOP_JUMP" || state === "SHOP_JUMP_RELEASE" || state === "SHOP" || state === "SNEAK_WAIT" || state === "HIT" || state === "ATTACK_HOLD" || state === "RELEASE" || state === "SOLD") key("sneak", false);
    if (state === "SHOP" || state === "SNEAK_WAIT" || state === "HIT" || state === "ATTACK_HOLD" || state === "RELEASE") aimShop(sale);
    if (autoClickSelling && (state === "HIT" || state === "ATTACK_HOLD")) attackShop(sale);
});

register("tick", function () {
    if (!on) { lastLoggedState = ""; return; }
    if (state !== lastLoggedState) { lastLoggedState = state; logVender("ESTADO", "coluna=" + (col + 1) + ", linha=" + (row + 1) + ", item=" + (sale || "-")); }
});
register("tick", function () {
    if (pendingSetHomeCommand === null) return;
    if (--pendingSetHomeTicks > 0) return;
    confirmSaleHome();
});
register("chat", function (message) {
    if (pendingSetHomeCommand === null) return;
    var text = String(message || "").toLowerCase();
    if (text.indexOf("já existe uma home") !== -1 || text.indexOf("ja existe uma home") !== -1) {
        // O servidor ainda está processando a primeira tentativa neste callback.
        // Aguarda 0,6 s antes de mandar a confirmação que substitui a home.
        pendingSetHomeTicks = 12;
        ChatLib.chat("&7[BolsoVender] Home existente detectada; confirmando substituição em seguida.");
    }
}).setCriteria("${message}");
register("command", function () { showSellHelp(); }).setName("bolsovenderhelp");
register("command", function () { showSellHelp(); }).setName("bolsovenderajuda");
register("command", function () {
    ChatLib.chat("&6&m----------- &eCalibrações BolsoVender &6&m-----------");
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var ready = aims[name] !== undefined && aims[name] !== null;
        ChatLib.chat((ready ? "&a✓ " : "&c✗ ") + "&f" + name + " &7→ " + sales[name].home + (ready ? " &a(calibrada)" : " &e(falta calibrar)"));
    }
    ChatLib.chat("&7Para calibrar: &e/bolsovender calibrar <nome>");
    ChatLib.chat("&6&m---------------------------------------------");
}).setName("bolsovendercalibracoes");
