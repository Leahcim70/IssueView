"""Build a portable VSIX using only Python's standard library."""
import json
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
package = json.loads((root / 'package.json').read_text())
strings = json.loads((root / 'package.nls.json').read_text())
description = strings['extension.description']
output = root / 'dist' / f"{package['name']}-{package['version']}.vsix"
output.parent.mkdir(exist_ok=True)
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}"/>
    <DisplayName>{escape(package['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(description)}</Description>
    <Tags>github,issues,sidebar</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="{','.join(package['extensionDependencies'])}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="English,German"/>
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/{package['icon']}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{package['icon']}" Addressable="true"/>
  </Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="md" ContentType="text/markdown"/>
<Default Extension="py" ContentType="text/plain"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
<Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>'''
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', content_types)
    files = [root / name for name in ['package.json', 'package.nls.json', 'package.nls.de.json', 'README.md', 'README.de.md', 'LICENSE', 'CHANGELOG.md']]
    for folder in ['src', 'media', 'l10n', 'test', 'scripts']:
        files.extend(p for p in (root / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    for file in sorted(files):
        archive.write(file, 'extension/' + file.relative_to(root).as_posix())
print(output)
