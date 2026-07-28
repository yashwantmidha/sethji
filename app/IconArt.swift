// Shared drawing for the sethji boss — gold turban, big mustache.
// Used by make_icon.swift (app icon .icns) and SethjiApp.swift (menu-bar
// button image), so both stay in sync from one sketch.

import AppKit

private func oval(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSBezierPath {
    NSBezierPath(ovalIn: NSRect(x: x - w / 2, y: y - h / 2, width: w, height: h))
}

/// Renders the boss on a 1024×1024 canvas.
/// `card: true`  → full app icon: Big Sur squircle card + crew pipeline dots.
/// `card: false` → head only, zoomed to fill the canvas (menu-bar use;
///                 set `.size` on the result to the point size you need).
func sethjiIconImage(card: Bool) -> NSImage {
    let size: CGFloat = 1024
    // Apple's icon grid: content card is 824pt inside a 1024pt canvas,
    // corner radius ~185pt. Everything outside stays transparent.
    let inset: CGFloat = 100
    let radius: CGFloat = 185

    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    if card {
        let cardPath = NSBezierPath(
            roundedRect: NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset),
            xRadius: radius, yRadius: radius)
        let bg = NSGradient(
            starting: NSColor(calibratedRed: 0.16, green: 0.16, blue: 0.19, alpha: 1),
            ending: NSColor(calibratedRed: 0.09, green: 0.09, blue: 0.11, alpha: 1))!
        bg.draw(in: cardPath, angle: -90)
        // Hairline rim so the card reads on dark backgrounds.
        NSColor(calibratedWhite: 1, alpha: 0.08).setStroke()
        cardPath.lineWidth = 6
        cardPath.stroke()
    } else {
        // Zoom the head (bbox roughly 200…824 × 250…880) to fill the canvas.
        let zoom = NSAffineTransform()
        zoom.translateX(by: 512, yBy: 512)
        zoom.scale(by: 1.55)
        zoom.translateX(by: -512, yBy: -565)
        zoom.concat()
    }

    let skin = NSColor(calibratedRed: 0.91, green: 0.72, blue: 0.53, alpha: 1)
    let skinShade = NSColor(calibratedRed: 0.82, green: 0.62, blue: 0.43, alpha: 1)
    let felt = NSColor(calibratedRed: 0.33, green: 0.34, blue: 0.40, alpha: 1)
    let feltDark = NSColor(calibratedRed: 0.17, green: 0.17, blue: 0.21, alpha: 1)
    let ink = NSColor(calibratedRed: 0.13, green: 0.09, blue: 0.07, alpha: 1)

    // Ears, then face.
    skinShade.setFill()
    oval(305, 470, 90, 120).fill()
    oval(719, 470, 90, 120).fill()
    skin.setFill()
    oval(512, 480, 430, 440).fill()

    // Full beard around the jaw, mouth hidden.
    ink.setFill()
    oval(512, 330, 400, 250).fill()

    // Fedora: wide brim, pinched crown, dark band with a teal pin.
    felt.setFill()
    oval(512, 640, 624, 96).fill()                          // brim
    NSBezierPath(roundedRect: NSRect(x: 330, y: 640, width: 364, height: 230),
                 xRadius: 70, yRadius: 70).fill()           // crown
    // Center crease down the crown.
    feltDark.setStroke()
    let crease = NSBezierPath()
    crease.move(to: NSPoint(x: 512, y: 855))
    crease.curve(to: NSPoint(x: 512, y: 710),
                 controlPoint1: NSPoint(x: 478, y: 810),
                 controlPoint2: NSPoint(x: 478, y: 755))
    crease.lineWidth = 14
    crease.stroke()
    // Band at the base of the crown.
    feltDark.setFill()
    NSRect(x: 330, y: 656, width: 364, height: 60).fill()
    // Pin in the terminal's teal.
    NSColor.systemTeal.setFill()
    oval(600, 686, 40, 40).fill()

    // Eyebrows and eyes.
    ink.setFill()
    oval(420, 528, 100, 30).fill()
    oval(604, 528, 100, 30).fill()
    oval(420, 468, 46, 52).fill()
    oval(604, 468, 46, 52).fill()
    NSColor(calibratedWhite: 1, alpha: 0.8).setFill()
    oval(428, 480, 14, 14).fill()
    oval(612, 480, 14, 14).fill()

    // Nose.
    skinShade.setFill()
    oval(512, 410, 70, 90).fill()

    // The mustache: two fat angled lobes with curled tips, over the beard.
    ink.setFill()
    for side in [CGFloat(-1), 1] {
        let lobe = oval(512 + side * 95, 330, 220, 85)
        let tilt = NSAffineTransform()
        tilt.translateX(by: 512 + side * 95, yBy: 330)
        tilt.rotate(byDegrees: side * 12)
        tilt.translateX(by: -(512 + side * 95), yBy: -330)
        lobe.transform(using: tilt as AffineTransform)
        lobe.fill()
        oval(512 + side * 205, 365, 70, 70).fill()
    }

    if card {
        // Crew pipeline dots: architect → coder → qa, same colors as the terminal.
        let dotColors = [NSColor.systemTeal, NSColor.systemYellow, NSColor.systemPurple]
        let dotR: CGFloat = 26
        let gap: CGFloat = 110
        let rowWidth = gap * CGFloat(dotColors.count - 1)
        for (i, c) in dotColors.enumerated() {
            let x = (size - rowWidth) / 2 + gap * CGFloat(i)
            c.setFill()
            oval(x, 172, dotR * 2, dotR * 2).fill()
        }
    }

    image.unlockFocus()
    return image
}
