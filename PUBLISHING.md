# IssueView veröffentlichen

Jedes veröffentlichte GitHub-Release landet automatisch im [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=michael-lantzen.issueview). Zuständig ist [`.github/workflows/marketplace.yml`](.github/workflows/marketplace.yml).

## Neue Version veröffentlichen

1. Version in `package.json` erhöhen und `CHANGELOG.md` ergänzen. Die VSIX-Dateinamen in `README.md` und `README.de.md` anpassen.
2. Testen und paketieren:
   ```sh
   npm test
   npm run package
   ```
3. Committen, pushen und das Release mit der VSIX anlegen:
   ```sh
   gh release create vX.Y.Z dist/issueview-X.Y.Z.vsix --title "IssueView X.Y.Z" --notes "…"
   ```
4. Der Workflow **Publish to Marketplace** startet von selbst. Nach der Prüfung durch Microsoft, die einige Minuten dauert, ist die Version öffentlich.

Ein bestehendes Release lässt sich auch nachträglich veröffentlichen:

```sh
gh workflow run marketplace.yml -f tag=vX.Y.Z
```

Eine Version, die schon im Marketplace ist, wird übersprungen (`--skip-duplicate`).

## So funktioniert der Workflow

1. `azure/login` meldet sich per OIDC bei Microsoft Entra ID an, als verwaltete Identität `issueview-publisher`. Es ist kein Token und kein Passwort gespeichert.
2. Der Workflow gibt die Marketplace-ID der Identität aus. Die braucht man nur bei der Einrichtung.
3. Er lädt die VSIX vom GitHub-Release herunter. Veröffentlicht wird also genau die getestete Datei.
4. `vsce publish --azure-credential` lädt sie in den Marketplace hoch.

Personal Access Tokens (PATs) von Azure DevOps werden am 1. Dezember 2026 abgeschaltet. Deshalb nutzt der Workflow Entra ID.

## Einrichtung

Diese Einrichtung ist bereits erledigt. Die Beschreibung dient zum Nachvollziehen oder für einen Neuaufbau. Als Konto für Azure und Marketplace dient `lantzen@mlsys.de` (Geschäfts-/Schulkonto).

| Wo | Was |
|---|---|
| Azure-Portal → **Verwaltete Identitäten** | `issueview-publisher` |
| Abonnement → **Zugriffssteuerung (IAM)** | Rolle **Leser** für die Identität |
| Identität → **Verbundanmeldeinformationen** | Szenario *GitHub Actions*, Entität **Umgebung** `marketplace`, Antragsteller `repo:Leahcim70@16537679/IssueView@1428067113:environment:marketplace` |
| GitHub → Settings → Environments → `marketplace` | Variablen `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| [Marketplace](https://marketplace.visualstudio.com/manage) → Publisher **Michael Lantzen** → **Members** | Marketplace-ID der Identität mit Rolle **Contributor** |

Die IDs sind nicht geheim. Client-ID und Abonnement-ID stehen in der **Übersicht** der Identität, die Mandanten-ID unter **Microsoft Entra ID**. Die Marketplace-ID gibt der Workflow-Schritt *Show Marketplace identity ID* aus.

## Fehlerbehebung

| Meldung | Ursache und Lösung |
|---|---|
| `azure/login` schlägt fehl (*AADSTS700213* o. ä.) | Der Antragsteller der Verbundanmeldeinformation passt nicht. Er muss genau wie oben lauten. Ein umbenanntes Repository ändert ihn nicht, ein neu angelegtes schon. |
| `Access Denied: <id> needs the following permission(s)` | Die Identität ist kein Mitglied des Publishers. Die `<id>` aus der Meldung im Marketplace unter **Members** als **Contributor** eintragen. |
| `Download release VSIX` schlägt fehl | Am Release hängt keine `.vsix`. Mit `gh release upload vX.Y.Z dist/issueview-X.Y.Z.vsix` nachreichen und den Workflow erneut starten. |
| Marketplace lehnt das Paket ab | Die Meldung steht im Log des Schritts *Publish* und im [Hub](https://marketplace.visualstudio.com/manage/publishers/michael-lantzen/extensions/issueview/hub). |

Notfalls kann man auch von Hand veröffentlichen: [Marketplace](https://marketplace.visualstudio.com/manage) → Publisher → IssueView → **Update** → VSIX hochladen.
