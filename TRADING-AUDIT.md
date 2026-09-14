# Trading-Audit — Midorii

**Stand:** 2026-09-12 · **Version:** 0.5.0 · **Branch:** main

Gelesen: `app/renderer/trading/*` (7.077 Z.), `app/renderer/replay/*` (Ticket, Dock, Quick-Panel,
Level-Gesten; 6.376 Z.), `shared/engine/broker.d.ts`, `shared/strategies/risk.js`,
`app/electron/data/projectx.js`.

Baseline zum Zeitpunkt des Audits: `npm run typecheck` sauber, `npm test` 201 Dateien /
2.646 Tests grün. Alle unten genannten Fehler liegen in Pfaden, die keine Tests abdecken.

Bybit und Binance sind laut Auftrag ausgenommen und nur dort erwähnt, wo sie als Vergleich
zeigen, was bei ProjectX fehlt.

---

## 1. Blocker — ProjectX ist nicht handelbar

> **Status: behoben am 2026-09-12.** 1.1–1.4 sind umgesetzt und mit 13 Tests abgedeckt.
> Die Befunde bleiben als Aufzeichnung stehen.

ProjectX ist der Referenz-Venue, aber der am wenigsten fertige Controller. Vier echte Bugs:

### 1.1 Positionen werden auf dem Chart nie gezeichnet

`ProjectXController.ts:497` schickt ein Objekt statt eines Strings:

```ts
this.indicator.setInput(STATE_INPUT, state as unknown as number);
```

Der Indikator akzeptiert nur Strings (`replayIndicator.ts:319`: `if (typeof raw === 'string')`).
Capital, Bybit, Binance und Paper machen alle `JSON.stringify(state)`.

Folge: keine Entry-Linie, keine Stop-/Target-Linie, kein P/L-Label — und weil
`wirePositionLevels` an genau diesen Linien hängt, funktioniert **das Ziehen von Stop und Target
auf dem Chart bei ProjectX gar nicht**. Der doppelte `as unknown`-Cast hat den Typfehler verdeckt.

Zusätzlich ist die Payload-Form falsch. Gebaut wird `{id, size, entryPrice, stopLoss, takeProfit}`,
erwartet wird `{id, side, entryPrice, entryTime, stopPrice, targetPrice, size, openPnl, stopPnl,
targetPnl, openR, stopR, targetR}`. Auch nach einem reinen Stringify-Fix zeichnet es nichts
Richtiges.

### 1.2 Brackets aus dem Ticket werden stillschweigend verworfen

`bracketTicks()` (`ProjectXController.ts:183`) liest ausschließlich `bracket.stopDistance` und
`bracket.targetDistance`. `ticketOrder()` (`orderTicket.ts`) erzeugt aber ausschließlich absolute
Level (`stopLoss` / `takeProfit`) — der Typ `OrderBracket` erlaubt beide Formen.

Folge: eine Market-Order aus dem Seitenpanel mit gesetztem Stop geht **ohne Stop raus**, ohne
Fehlermeldung. Der gefährlichste Fund des Audits: der Nutzer sieht einen Stop im Ticket und hat
keinen im Markt.

### 1.3 Der Orphan-Sweep löscht Arbeits-Orders des Nutzers

`sweepOrphans()` filtert `!held.has(contractId) && (type === stop || type === limit)`. Ein bewusst
platzierter Limit-Entry hat per Definition keine Position und wird deshalb innerhalb von 5 s
gecancelt.

Der Kommentar darüber sagt ausdrücklich "a resting entry the person placed deliberately is not this
function's business" — der Code tut das Gegenteil.

### 1.4 Der Dock zeigt keine ProjectX-Orders

`ProjectXController.ts:131`:

```ts
book(): TradeBook { return venueBook(this.open, [], (p) => p.unrealized); }
```

Leeres Order-Array hart verdrahtet; alle anderen Controller übergeben `this.resting`. Folge: die
Order-Liste im Dock ist immer leer und einzelne Orders sind nicht stornierbar, obwohl `orders()`
und `cancelOrder()` existieren. Der Zähler im Seitenpanel zeigt trotzdem die richtige Zahl — die
Liste widerspricht dem Zähler.

---

## 2. Korrektheit — Sizing rechnet Futures falsch

> **Status: behoben am 2026-09-12.** 2.1–2.3 sind umgesetzt, dazu ein vierter Einstiegsweg,
> der beim Audit nicht aufgeführt war: das Quick-Panel rechnete den Risikobetrag direkt in
> die Stop-Distanz um und lag damit um denselben Faktor daneben. 17 neue Tests.
> Offen geblieben: Capital.com misst weiterhin in Punkten — siehe Hinweis unter 2.1.

### 2.1 Kein Kontraktmultiplikator im Ticket

`ticketPlan()` rechnet `risk = |ref − stop| × size` und `notional = size × price`. Beides gilt nur
für Spot, wo ein Punkt eine Währungseinheit ist.

Für NQ (tickValue 5 bei tickSize 0.25 → 20 $/Punkt) ist das ausgewiesene Risiko um **Faktor 20 zu
klein**, die risikobasierte Größe entsprechend 20× zu groß. Gedeckelt wird sie nur vom
Leverage-Ceiling, das für Futures ebenfalls unsinnig ist: `equity × maxLeverage / price` ergibt bei
50k Equity und NQ @ 24.000 zwei Kontrakte und hat mit Futures-Margin (pro Kontrakt, nicht nach
Notional) nichts zu tun.

Der Faktor ist vorhanden — `tickValue / tickSize` —, nur nirgends im Sizing-Pfad.
`CapitalController.pointValue()` kennt das Konzept, benutzt es aber nur zum Zeichnen.

**Nötig:** `pointValue` in `TicketAccount`, und die `positionSize`-Aufrufe damit durchmultiplizieren.

**Umgesetzt so:** `TicketAccount.pointValue` und `TradingController.pointValue()`, Preise werden
vor `positionSize` in Kontowährung umgerechnet — eine Implementierung der Sizing-Regel, nicht zwei.
ProjectX liefert `tickValue / tickSize`.

**Capital nachgezogen am 2026-09-13.** Zwei Wege, und nur die beiden zählen als Wissen:

- Bucht das Instrument in der Kontowährung, ist `lotSize` die exakte Antwort. Beides steht in
  `marketInfo` (`instrument.lotSize`, `instrument.currency`) gegen die Kontowährung.
- Eine Position, die sich bewegt hat, sagt es exakt inklusive Umrechnung: `upl` geteilt durch die
  zurückgelegte Distanz. Dieser Wert gewinnt.

Gelernt wird jetzt beim **Lesen** der Positionen, nicht beim Zeichnen — vorher hing es im
`pushState`, also lernte ein Konto ohne angehängten Chart-Indikator nie etwas. Und der Wert wird
pro **Instrument** statt pro `dealId` gehalten: vorher war er in dem Moment vergessen, in dem die
Position schloss, also genau zwischen den Trades.

**Offen bleibt nur der Kreuzwährungsfall vor dem ersten Trade:** EUR-Konto auf einem
USD-Instrument, noch nie etwas offen gehabt. Dann gibt `pointValue()` `null` zurück, der Mount
reicht nichts weiter, und das Ticket rechnet wie bisher mit 1. Ein Kurs wird nicht erfunden.

### 2.2 Angezeigte Größe ≠ gesendete Größe

Jeder Controller quantisiert selbst: Binance und Bybit `floor`, Capital und ProjectX `round`. Das
Ticket zeigt vorher ungerundet an.

Bei ProjectX werden 1,6 Kontrakte auf 2 **aufgerundet**, also über das Risikobudget hinaus; 0,4
wird zu 0 und dann als Fehler abgewiesen. `TradingController` braucht ein `quantize(size)` bzw.
`sizeStep()`, damit das Ticket den tatsächlichen Wert zeigt und die Ablehnung vor dem Klick kommt.
Beim Risiko-Sizing darf nie aufgerundet werden.

### 2.3 Gleiches Problem im Chart-Block

`replayOrders.ts` ruft `positionSize(...)` ohne Quantisierung und ohne Multiplikator auf. Ein
gezeichneter Block auf NQ ist damit doppelt falsch.

---

## 3. Fehlende Infrastruktur

> **Status: behoben am 2026-09-12.** 3.1-3.5 sind umgesetzt, 59 neue Tests.
> Hub-Methoden und Trade-Endpoint wurden gegen gateway.docs.projectx.com verifiziert,
> nicht aus dem Gedächtnis geschrieben. Siehe die Hinweise unter 3.1 und 3.2 zu dem,
> was als Annahme stehengeblieben ist.

### 3.1 Kein ProjectX User-Hub

`projectx.js` nutzt nur den Market-Hub (Quotes, Trades). Order-, Position-, Trade- und
Account-Events werden nicht abonniert; stattdessen pollt der Controller alle 5 s **vier
REST-Calls**: `positions`, `openOrders`, `accounts`, `account`.

Konsequenzen: Fills erscheinen bis zu 5 s zu spät, das Orphan-Fenster nach einem Stop-Fill ist real
(im Code ehrlich benannt), und die Call-Rate ist bei Ratelimits riskant. Der User-Hub macht beides
überflüssig.

**Umgesetzt so:** zweiter SignalR-Socket auf `/hubs/user`, `SubscribeAccounts/Orders/Positions/Trades`
je gewähltem Konto, die vier `GatewayUser*`-Events als **Türklingel, nicht als Nachricht** — der
Controller liest daraufhin per REST nach. Damit hängt nichts an der Nutzlastform der Events;
behauptet und verifiziert werden nur die Methoden- und Eventnamen. Der Poll-Takt fällt von 5 s auf
30 s, sobald der Socket steht, und bleibt bei 5 s, wenn er nicht aufgeht. Ereignis-Bursts eines Fills
werden zu einer Lesung zusammengefasst; eine während einer laufenden Lesung angeforderte wird
gemerkt statt verworfen.

### 3.2 Keine Trade-Historie bei ProjectX

`history()` wird dem Seitenpanel nur von Paper und Capital übergeben (Capital über
`liveJournal.ts`). Für ProjectX gibt es im IPC-Surface kein `trades()` — also kein History-Tab,
keine P/L-Kurve, kein realisiertes Ergebnis, keine R-Auswertung. `liveJournal` ist generisch genug
zur Wiederverwendung.

**Umgesetzt so:** `/api/Trade/search` plus `projectxHistory.ts`, das die Halb-Turns zu Round-Trips
paart — gewichteter Einstieg, Teilausstiege, Umkehrungen, voided-Fills. **Eine Annahme steckt drin:**
Das Gateway nennt `profitAndLoss` und `fees` getrennt und sagt nicht, ob das eine das andere schon
enthält. Gelesen wird es als brutto, die Kommission wird abgezogen. Die Stelle ist als benannte
Konstante `PNL_IS_GROSS` markiert, damit es eine Zeile ist, falls sich das als falsch erweist.

### 3.3 Keine Risiko-Guardrails

Für ein Prop-Firm-Ziel (Topstep) eine Lücke, kein Nice-to-have: kein Daily-Loss-Limit, kein
Trailing-Drawdown-Tracker, keine Max-Kontrakte, kein Lockout nach N Verlusten. `PaperSettings`
kennt nur `maxLeverage`.

### 3.4 Keine Tastaturbedienung

Im gesamten Renderer gibt es außerhalb von zwei Eingabefeldern kein `keydown`. Kein Flatten-Hotkey,
kein Buy/Sell, kein ESC für Cancel-All. TopstepX-Nutzer arbeiten über Tastatur.

### 3.5 ProjectX liefert Bid/Ask, das Ticket nutzt es nicht

`GatewayQuote` führt `bestBid` und `bestAsk`, `TicketAccount` hat die Felder — nur der
`projectxMount` gibt sie nicht weiter. Capital ist derzeit das einzige Venue mit zweiseitigem
Header.

---

## 4. Kleinere Bugs

> **Status: behoben am 2026-09-12.** Alle fünf. Der vierte (`setLevel` / doppelter
> Reconcile) war bereits durch den Reconcile-Umbau aus 3.1 erledigt — eine während einer
> laufenden Lesung angeforderte wird gemerkt statt verworfen.

- **`tradeMode.ts` `startPaper()`**: kein `try/finally` um `starting = false` (alle anderen Starts
  haben eins). Wirft `mountPaperTrading`, bleibt `starting === true` — das Trade-Menü ist ab dann
  dauerhaft und stumm tot.
- **`ProjectXController.breakEvenRefusal()`**: `position.stopLoss === position.entryPrice` als
  Float-Vergleich; sollte auf Tick-Toleranz prüfen.
- **`protect()`** setzt die Order-Größe auf die volle Positionsgröße; nach einem Teil-Close bleibt
  der alte Stop überdimensioniert stehen, `size` wird nie nachgezogen.
- **`setLevel()`** ruft `send()` → `reconcile()`, und `protect()` ruft `setLevel()` zweimal; der
  zweite `reconcile()` fällt am `reconciling`-Guard raus, der State ist danach eine Runde alt.
- **`PaperSettings`** ist de facto die globale Trading-Konfiguration, heißt aber "Paper trading
  settings" und ist nur über das Zahnrad in der Paper-Zeile erreichbar. Wer Risiko oder Quick-Sizes
  für sein Live-ProjectX-Konto ändern will, muss ein Paper-Menü öffnen.

---

## 5. UX gegenüber ProjectX/TopstepX und TradingView

> **Status: umgesetzt am 2026-09-12.** Alle sechs Punkte. Gebaut in der Design-Sprache des
> Projekts — `--vela-*`-Tokens, keine erfundenen Zwischenwerte, Zahlen durchgehend
> `tabular-nums`. Was die Leiter bewusst NICHT zeichnet, steht unter Punkt 1 unten.

### Was stark ist und bleiben sollte

- Refusal-Text statt eines grauen Buttons (`ticketRefusal`) — beantwortet die Frage "welches Feld
  muss ich korrigieren?", die ein deaktivierter Button offen lässt.
- Das zweiseitige Quote als Richtungswahl statt als reine Anzeige.
- Trennung Dock (was läuft) / History-Tab (was war).
- Zwei-Klick-Arming am Close-Button.
- Overlay-Cards mit freier Positionierung.

### Was fehlt, nach Wirkung sortiert

1. **DOM / Preisleiter.** ✅ Als vierter Reiter der Handelsleiste (`priceLadder.ts`), Logik als
   reine Funktionen getrennt und getestet. **Keine Tiefenspalte** — das Gateway veröffentlicht
   nur Top-of-Book, und eine erfundene Tiefe wäre das überzeugendste falsche Element auf dem
   Schirm. Stattdessen: eigene Orders und Position je Preiszeile, Best Bid/Ask markiert,
   Session-Volumen als Balken hinter den Preisen, Klick links kauft / rechts verkauft (Limit
   unter, Stop über dem Markt), Größe aus den Quick-Sizes. Das Volumen kommt aus dem Bar-Strom
   und beginnt daher, wenn der Chart aufgeht — das steht auf dem Panel, statt entdeckt zu werden.

   Ursprünglicher Befund: das zentrale Element in TopstepX, ohne Entsprechung hier. Die Messung
   (Depth = nur Top-of-Book plus Session-Volumenprofil) schließt eine echte Tiefenleiter aus — aber
   eine Leiter mit Best-Bid/Ask, eigenen Orders und Position pro Preiszeile und dem
   Session-Volumenprofil als Hintergrund ist damit baubar und deckt den größten Teil des Nutzens
   ab. Hier liegt zugleich der größte Customization-Hebel.
2. **Ruhende Orders auf dem Chart ziehbar.** ✅ Ziehen nur, wo der Account eine Order auch
   bewegen kann (Paper, Capital, ProjectX) — das Flag `ordersMovable` am State entscheidet
   es. Stornieren ist nicht gesperrt, das können alle sechs Controller. `wirePositionLevels` behandelt nur Positions-Level;
   Orders werden gezeichnet, sind aber unbeweglich. `modifyOrder` existiert in allen Controllern.
   Kleinste Änderung mit dem größten "fühlt sich wie TradingView an"-Effekt.
3. **Time & Sales.** ✅ Eigener Reiter; Prints laufen jetzt bis in den Renderer durch. Der Trade-Stream läuft bereits durch `foldTrade`, die Aggressor-Seite steht im
   `type`-Feld. Die Daten sind da, es fehlt nur die Ansicht.
4. **Hotkeys** ✅ (in §3.4 erledigt), mit sichtbarer und editierbarer Belegung — passt zum Customization-Fokus.
5. **Fill-Feedback**: ✅ Ton oder Toast beim Fill. Aktuell erfährt man einen Stop-Fill daran, dass die
   Position aus dem Dock verschwindet.
6. **Konto-Band vereinheitlichen.** ✅ `accountBand.ts`; ProjectX und Capital nutzen es, mit wählbaren Spalten. Bybit und Binance bleiben laut Auftrag außen vor und haben weiter ihr eigenes Band. Jeder Mount baut sein eigenes Band (`midorii-projectx`,
   `midorii-capital`, …) mit eigenem CSS — vier Kopien derselben Leiste, die auseinanderdriften, und
   an keiner kann der Nutzer einstellen, welche Kennzahlen er sehen will. Ein gemeinsames Band mit
   wählbaren Spalten wäre Entdopplung und Customization-Feature in einem.

---

## Reihenfolge

1. **§1.1–1.4** — ProjectX überhaupt funktionsfähig machen, mit Tests genau dort, wo aktuell keine
   sind: Indikator-Payload, Bracket-Durchreichung, Sweep gegen eine Arbeits-Order.
2. **§2.1–2.3** — Multiplikator und Quantisierung. Ohne das ist keine Futures-Größe im Ticket
   ehrlich.
3. **§3.1** — User-Hub. Löst Latenz, Orphan-Fenster und Ratelimit in einem Zug.
4. **§3.3** Guardrails, **§4** Kleinkram.
5. UX: ziehbare Orders → DOM → Tape → Hotkeys.

§1.2 (stillschweigend verworfener Stop) und §2.1 (Risiko um Faktor 20 daneben) sind die beiden
Punkte, vor deren Behebung nicht mit echtem Geld gehandelt werden sollte.

---

## Abschluss

Alle fünf Punkte sind umgesetzt (Stand 2026-09-12). Gate: `typecheck`, `lint`, volle Testsuite
grün; von 2.646 auf 2.774 Tests.

**Was weiterhin nicht verifiziert ist:** kein einziger Lauf gegen ein echtes ProjectX-Konto. Der
User-Hub, der Trade-Endpoint und der Print-Strom sind gegen die dokumentierte Schnittstelle
gebaut und mit Stubs getestet — nicht gegen den echten Socket. Das ist der erste Schritt vor dem
ersten echten Trade.

**Bewusst offen gelassen:**

- Capital.com kennt den Punktwert im Kreuzwährungsfall erst nach dem ersten Trade (§2.1). Bis
  dahin rechnet das Ticket dort mit 1; ein Wechselkurs wird nicht erfunden.
- `PNL_IS_GROSS` in `projectxHistory.ts` ist eine Annahme, keine Messung.
- Bybit und Binance sind laut Auftrag durchgehend ausgenommen.
- Eine fremd auf der TopstepX-Oberfläche platzierte Order auf flachem Kontrakt wird weiterhin
  vom Orphan-Sweep erfasst (§1.3) — die sicherere der beiden Fehlerrichtungen.
