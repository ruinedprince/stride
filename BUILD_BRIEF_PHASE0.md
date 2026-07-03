# Stride — Build Brief, Phase 0 (Core que roda)

**Objetivo:** um núcleo *demonstrável e que roda de verdade* — gerar uma caminhada em
**loop** de uma distância-alvo a partir de um ponto, em **Guaratinguetá-SP (Brasil)**,
desenhada num mapa, terminando exatamente onde começou. Sem mocks no caminho crítico.

Projeto greenfield em `C:\Users\11sok\Documents\Stride` (vazio, Windows 11, PowerShell).

## Não-negociáveis
- 100% open source, **zero API paga**. Motor de rota: **GraphHopper** (Apache 2.0),
  perfil `foot`, algoritmo `round_trip`.
- **Extrato OSM pequeno por bounding box** de Guaratinguetá — NÃO baixar o Sudeste inteiro.
  BBox: lon `-45.30`..`-45.08`, lat `-22.92`..`-22.70`. Obter via extract.bbbike.org
  (recorte custom → formato `.osm.pbf` / Protocolbuffer) ou Overpass. Alvo: poucos MB.
- Frontend: **MapLibre GL JS** (Vite, sem framework pesado) — form com ponto de partida
  (default lat `-22.8164`, lon `-45.1927`), distância em km, botão "Gerar rota"; desenha a
  polyline retornada e marca início/fim.
- Chamada de rota: por simplicidade, o frontend chama o **GraphHopper HTTP local**
  (`http://localhost:8989/route`) direto. Só adicionar um proxy fino (Node) se o CORS
  bloquear.

## Notas técnicas que evitam tropeços conhecidos
- `round_trip` exige **modo flexível** (não CH). No config, defina o profile `foot` e use
  `ch.disable=true` na request, ou não prepare CH para esse profile.
- Request típica: `point=-22.8164,-45.1927&profile=foot&algorithm=round_trip&`
  `round_trip.distance=6000&round_trip.seed=0&points_encoded=false`.
- Java: GraphHopper precisa de JDK 17+. Verifique (`java -version`); se faltar, instale
  (winget: `winget install Microsoft.OpenJDK.17`) e documente.
- Baixe o `graphhopper-web` jar oficial da release estável; crie `config.yml` a partir do
  exemplo, apontando `datareader.file` para o `.pbf` do recorte; suba com
  `java -Ddw.graphhopper.datareader.file=<pbf> -jar graphhopper-web-*.jar server config.yml`.

## Definition of Done (em camadas — entregue o máximo que der na janela)
1. **(obrigatório)** Repo scaffoldado, `git init`, `README.md` com passos EXATOS de execução;
   frontend que renderiza uma rota a partir de uma resposta GraphHopper (mesmo que, se o
   server não subir a tempo, use um JSON de exemplo **claramente rotulado como SAMPLE**).
2. **(alvo)** GraphHopper rodando local sobre o extrato de Guaratinguetá; loop de **6 km** a
   partir do centro retorna e é desenhado, terminando no início.
3. **(stretch)** mostrar distância/duração/elevação; 2-3 distâncias-preset (3/6/10 km).

## Guardrails (honestidade > demo bonita)
- **Não finja** roteamento real. Se não conseguir subir o GraphHopper na janela, rotule
  qualquer dado como SAMPLE e documente exatamente o que falta.
- Ao final, **relate com honestidade**: o que roda de fato, os comandos exatos para iniciar,
  o que ficou stub, e o gancho para a Fase 1 (scoring de verde via tags OSM
  `natural=tree`/parques/`surface` num `custom_model`).
- Ambiente Windows: comandos PowerShell-friendly.
