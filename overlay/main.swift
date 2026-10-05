// Floating notes overlay that asks macOS to leave it out of screen capture.
// Build: swiftc -O main.swift -o overlay   Run: ./overlay
// Toggle: ⌃⌥Space (global).  Quit: ⌘Q while focused.
import AppKit
import Carbon.HIToolbox

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var panel: OverlayPanel!
    var hotKeyRef: EventHotKeyRef?

    func applicationDidFinishLaunching(_ note: Notification) {
        let frame = NSRect(x: 80, y: 400, width: 380, height: 260)
        panel = OverlayPanel(contentRect: frame,
                             styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                             backing: .buffered, defer: false)
        panel.title = "Overlay"
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = NSColor.black.withAlphaComponent(0.55)

        // The flag: exclude this window's contents from screenshots / screen sharing.
        panel.sharingType = .none

        let scroll = NSTextView.scrollableTextView()
        scroll.frame = panel.contentView!.bounds
        scroll.autoresizingMask = [.width, .height]
        scroll.drawsBackground = false
        let text = scroll.documentView as! NSTextView
        text.drawsBackground = false
        text.textColor = .white
        text.insertionPointColor = .white
        text.font = .systemFont(ofSize: 15)
        text.textContainerInset = NSSize(width: 12, height: 28)
        text.string = UserDefaults.standard.string(forKey: "notes") ?? "Type notes here…"
        NotificationCenter.default.addObserver(forName: NSText.didChangeNotification, object: text, queue: .main) { _ in
            UserDefaults.standard.set(text.string, forKey: "notes")
        }
        panel.contentView!.addSubview(scroll)
        panel.orderFrontRegardless()

        registerHotKey()
    }

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, ctx in
            let me = Unmanaged<AppDelegate>.fromOpaque(ctx!).takeUnretainedValue()
            me.panel.isVisible ? me.panel.orderOut(nil) : me.panel.orderFrontRegardless()
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x4F564C59), id: 1) // 'OVLY'
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon
let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
let sub = NSMenu(); sub.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
sub.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
sub.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
sub.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
item.submenu = sub; app.mainMenu = menu
app.run()
