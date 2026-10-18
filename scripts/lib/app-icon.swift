// The icon macOS shows for an installed app, drawn at 1024 px into a transparent PNG.
//   swift scripts/lib/app-icon.swift <App.app> <out.png> [--own] -AppleIconAppearanceTheme RegularLight -AppleInterfaceStyle Light
// The trailing pair overrides the Mac's own icon and appearance setting (a Dark or Tinted icon
// style would otherwise come through) for this one process, so it is always the default icon.
// `--own` draws the app's own icon artwork from its bundle instead: macOS 26 sets an icon that
// isn't drawn to its new grid on a grey plate, which the app itself never shows.
// Given an .svg instead of an app, it draws that (a maker's vector mark) at 1024 px.
import AppKit

let args = CommandLine.arguments
let app = args[1], out = args[2]
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
  let icon: NSImage
  if app.hasSuffix(".svg") {
    icon = NSImage(contentsOfFile: app)!
  } else if args.contains("--own"), let bundle = Bundle(path: app),
            let own = bundle.image(forResource: (bundle.object(forInfoDictionaryKey: "CFBundleIconName") as? String) ?? "AppIcon") {
    icon = own
  } else {
    icon = NSWorkspace.shared.icon(forFile: app)
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  icon.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
}
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
