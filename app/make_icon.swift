// Writes the sethji app icon (drawn in IconArt.swift) as a 1024×1024 PNG.
// Built by install_app.sh:
//   swiftc app/IconArt.swift app/make_icon.swift -o make_icon
//   ./make_icon /path/to/icon_1024.png

import AppKit

@main
struct MakeIcon {
    static func main() {
        guard CommandLine.arguments.count > 1 else {
            FileHandle.standardError.write("usage: make_icon <out.png>\n".data(using: .utf8)!)
            exit(1)
        }
        let outPath = CommandLine.arguments[1]

        let image = sethjiIconImage(card: true)
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write("failed to encode PNG\n".data(using: .utf8)!)
            exit(1)
        }
        do {
            try png.write(to: URL(fileURLWithPath: outPath))
        } catch {
            FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
    }
}
