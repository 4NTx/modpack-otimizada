var iaAtiva = false;
var apiKeyGoogle = "AQ.Ab8RN6LpOZh8FtfZ9tX3QF4WgX7TXAl_-LMDl18fCABS5GXXPA"; // Lembre-se de usar uma chave nova!

register("command", function () {
    iaAtiva = !iaAtiva;
    if (iaAtiva) {
        ChatLib.chat("&d[IA BOT] LIGADO! Respondendo tells (Modo Natural/Humano).");
    } else {
        ChatLib.chat("&c[IA BOT] DESLIGADO.");
    }
}).setName("ia");

register("chat", function (jogador, mensagem) {
    if (!iaAtiva) return;
    if (jogador === Player.getName() || jogador === "") return;

    ChatLib.chat("&d[IA BOT] Pensando em resposta para " + jogador + "...");

    new Thread(function () {
        try {
            var URL = Java.type("java.net.URL");
            var BufferedReader = Java.type("java.io.BufferedReader");
            var InputStreamReader = Java.type("java.io.InputStreamReader");
            var OutputStreamWriter = Java.type("java.io.OutputStreamWriter");
            var Thread = Java.type("java.lang.Thread");

            var urlString = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" + apiKeyGoogle.trim();
            var url = new URL(urlString);
            var conn = url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);

            // NOVO PROMPT: Muito mais humano e adaptável a qualquer assunto
            var instrucaoSistema = "Você é um jovem brasileiro jogando Minecraft, conversando com um amigo no chat privado (/tell). " +
                "ATENÇÃO: A conversa não é só sobre o jogo. Se o assunto for vida real, rotina, piadas ou papo furado, responda normalmente como uma pessoa comum. " +
                "Só use gírias do jogo se o assunto for realmente Minecraft. " +
                "Seja informal, descontraído e use linguajar da internet (mano, kkkk, pdc, suave, tô, vc, ss, nn). " +
                "REGRAS: 1. NUNCA use aspas ou asteriscos. 2. Nunca fale de forma robótica, poética ou muito formal. 3. Aja 100% como um ser humano real digitando rápido.";

            var payload = JSON.stringify({
                "systemInstruction": {
                    "parts": [{ "text": instrucaoSistema }]
                },
                "contents": [{
                    "parts": [{ "text": mensagem }]
                }],
                "generationConfig": {
                    "maxOutputTokens": 120,
                    "temperature": 0.8 // Um pouco mais criativo e natural
                }
            });

            var writer = new OutputStreamWriter(conn.getOutputStream(), "UTF-8");
            writer.write(payload);
            writer.flush();
            writer.close();

            var responseCode = conn.getResponseCode();

            if (responseCode === 200) {
                var reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                var response = "";
                var line;
                while ((line = reader.readLine()) !== null) { response += line; }
                reader.close();

                var jsonResponse = JSON.parse(response);
                var respostaIA = jsonResponse.candidates[0].content.parts[0].text;

                var respostaLimpa = respostaIA.replace(/(\r\n|\n|\r)/gm, " ").trim();

                if (respostaLimpa.length > 0) {
                    var limiteCaracteres = 85;
                    var palavras = respostaLimpa.split(" ");
                    var pedacos = [];
                    var pedacoAtual = "";

                    for (var j = 0; j < palavras.length; j++) {
                        if ((pedacoAtual.length + palavras[j].length) > limiteCaracteres) {
                            pedacos.push(pedacoAtual.trim());
                            pedacoAtual = palavras[j] + " ";
                        } else {
                            pedacoAtual += palavras[j] + " ";
                        }
                    }
                    if (pedacoAtual.trim().length > 0) {
                        pedacos.push(pedacoAtual.trim());
                    }

                    for (var k = 0; k < pedacos.length; k++) {
                        ChatLib.say("/tell " + jogador + " " + pedacos[k]);
                        ChatLib.chat("&d[IA BOT] Respondido (" + (k + 1) + "/" + pedacos.length + ") para " + jogador + ": &f" + pedacos[k]);

                        if (k < pedacos.length - 1) {
                            Thread.sleep(1500);
                        }
                    }
                }
            } else {
                var errorStream = conn.getErrorStream();
                var errorResponse = "Sem detalhes";
                if (errorStream !== null) {
                    var errorReader = new BufferedReader(new InputStreamReader(errorStream, "UTF-8"));
                    errorResponse = "";
                    var errLine;
                    while ((errLine = errorReader.readLine()) !== null) { errorResponse += errLine; }
                    errorReader.close();
                }
                ChatLib.chat("&c[ERRO GOOGLE] Código " + responseCode + ": " + errorResponse);
            }

        } catch (e) {
            ChatLib.chat("&c[ERRO FATAL NA IA] " + e.toString());
        }
    }).start();

}).setCriteria("(Mensagem de ${jogador}): ${mensagem}");