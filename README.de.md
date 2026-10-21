# IssueView für Visual Studio Code

[English](README.md) | Deutsch

Die Oberfläche folgt automatisch der VS-Code-Anzeigesprache: Deutsch für `de`, sonst Englisch. Über **Configure Display Language / Anzeigesprache konfigurieren** in der Befehlspalette kann die Sprache geändert werden. Issue-Titel und -Inhalte bleiben in ihrer Originalsprache.

Zeigt die GitHub-Issues des geöffneten Projekts direkt in der **sekundären Seitenleiste (standardmäßig rechts)**. Für Windows, macOS und Linux; VS Code **1.106 oder neuer**. Kein zusätzliches npm-Paket und keine GitHub-CLI erforderlich.

## Installation

1. Die Datei `issueview-0.2.1.vsix` aus dem [neuesten Release](https://github.com/Leahcim70/IssueView/releases/latest) herunterladen.
2. VS Code: Erweiterungen → `…` → **Aus VSIX installieren… / Install from VSIX…**.
3. Einen vertrauenswürdigen lokalen Projektordner mit GitHub-Git-Remote öffnen.
4. Rechts **IssueView → Bei GitHub anmelden** anklicken und die Anmeldung bestätigen.

Falls die rechte Seitenleiste ausgeblendet ist: **Ansicht → Darstellung → Sekundäre Seitenleiste**. Die Ansicht lässt sich auch über die Befehlspalette mit **View: Open View… → IssueView** öffnen. Die Seitenposition folgt dem von dir eingestellten VS-Code-Layout.

Alternativ zur Installation über das Menü:

```sh
code --install-extension issueview-0.2.1.vsix
```

Die frühere Version hieß `project-issues-sidebar`. Diese bitte vor Installation von IssueView deinstallieren, um doppelte Ansichten zu vermeiden.

## Bedienung

- Zeigt standardmäßig offene Issues mit Nummer, Titel und Labels, sortiert nach letzter Änderung.
- Ein Klick öffnet das Issue im Browser. Ein Tooltip zeigt einen Auszug aus der Beschreibung als sicheren Text.
- **Aktualisieren** lädt den aktuellen Stand. Es gibt kein periodisches Hintergrund-Polling.
- **Status filtern** wechselt zwischen offen, geschlossen und allen Issues.
- **Repository auswählen** erlaubt bei mehreren Projekten eine feste Auswahl. Im automatischen Modus folgt die Ansicht dem Repository der aktiven Datei; ohne aktive Datei verwendet sie das erste erkannte Git-Repository.
- Bevorzugt den Remote des aktuellen Upstream-Branches, danach `origin`, danach den ersten erkannten GitHub-Remote.
- **Weitere Issues laden** lädt die nächste API-Seite. Pull Requests werden ausgeblendet; eine Seite kann deshalb weniger als 100 Issues enthalten.

## Anmeldung und Datenschutz

Verwendet den eingebauten GitHub-Anmeldedienst von VS Code. Tokens werden weder in Einstellungen geschrieben noch protokolliert. Anfragen gehen ausschließlich an `https://api.github.com`; Browser-Links ausschließlich an `https://github.com`.

Die Anmeldung fordert nur die Berechtigung `read:user` an; das genügt für öffentliche Repositories. Private Repositories benötigen zusätzlich die OAuth-Berechtigung `repo`. IssueView fragt sie erst an, wenn ein Repository nicht gefunden wird, oder über **IssueView: Zugriff auf private Repositories erlauben**. Diese GitHub-Berechtigung ist technisch umfassender als reiner Lesezugriff; die Erweiterung selbst führt ausschließlich lesende API-Anfragen aus. Organisationen mit SSO können eine zusätzliche Freigabe benötigen. Abmelden bzw. Zugriff widerrufen ist über die VS-Code-Kontoverwaltung möglich.

Unterstützt GitHub.com, einschließlich dort gehosteter privater Organisations-Repositories. GitLab, Azure DevOps, eigene GitHub-Enterprise-Server und reine virtuelle Browser-Workspaces sind in dieser Version nicht enthalten. Ein SSH-Hostalias anstelle von `github.com` wird nicht aufgelöst.

## Quellcode und Entwicklung

Der vollständige Quellcode einschließlich Tests und Paketierung liegt in diesem Repository. Zum Entwickeln das Repository klonen und mit VS Code öffnen.

```sh
npm test
npm run package
```

Die Tests benötigen Node.js 22 oder neuer; die Paketierung Python 3. Die Erweiterung nutzt die in VS Code enthaltene Node.js-Laufzeit. Ein `npm install` ist nicht erforderlich. Die Paketierung schreibt `dist/issueview-0.2.1.vsix` und erzeugt eine installierbare VSIX ohne Veröffentlichung im Marketplace. Die getestete VSIX wird an ein GitHub-Release angehängt.

Technische Referenzen:
- https://code.visualstudio.com/updates/v1_106 (Secondary Side Bar contribution)
- https://code.visualstudio.com/api/references/vscode-api (Tree View und Authentication API)
- https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10

## Prüfung dieser Version

Automatisierte Tests prüfen Remote-Erkennung, sichere API-Zieladressen, Authentifizierungsheader, Fehlerfälle, Abbruch und Pagination mit ausgefilterten Pull Requests. Ein zusätzlicher Test simuliert die VS-Code-API einschließlich Projektwechsel während laufender Abfragen. Die tatsächliche GitHub-OAuth-Anmeldung und der Zugriff auf ein privates Repository müssen nach Installation mit deinem Konto bestätigt werden.
