# Modpack Prism/Linux — Minecraft 1.8.9

Este repositório é um template leve para Prism Launcher. Ele não contém launcher Windows, assets, libraries ou versões do Minecraft: o Prism baixa e mantém esses arquivos compartilhados entre as instâncias.

## Instalação

1. Instale o Prism Launcher em uma sessão gráfica Linux (VNC/X11) e entre na conta Microsoft.
2. Crie uma instância `Minecraft 1.8.9` com Forge `11.15.1.2318`.
3. Abra a instância uma vez e feche-a.
4. Copie o conteúdo de `data/.minecraft/` deste repositório para a pasta `.minecraft/` da instância, mesclando as pastas.
5. Em `Settings > Java`, selecione Java 8 e teste a instalação.

## Perfil para VPS de 8 GB

Para três clientes simultâneos, configure em cada instância:

```text
Memória mínima: 512 MB
Memória máxima: 1280 MB
Argumentos JVM: -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:MaxGCPauseMillis=50 -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:InitiatingHeapOccupancyPercent=15 -XX:+DisableExplicitGC
```

Para somente dois clientes, a memória máxima pode ser `1536 MB` por instância.

## O que foi mantido

- ChatTriggers e as macros BolsoArcos, BolsoCiclo, BolsoFarm e BolsoVender;
- AutoLogin e AutoReconnect;
- Essential exigido pelo carregamento atual do ChatTriggers;
- configurações de vídeo leves: distância 2, gráficos rápidos, partículas mínimas, sem resource pack, VBO ligado e mipmaps desligados.

Cada conta deve usar sua própria instância Prism; não compartilhe a mesma pasta `.minecraft` entre clientes, pois as macros gravam progresso e estado.
