import AppKit
import UserNotifications

// sethji.app — a small macOS menu-bar front-end for the `sethji` CLI, in the
// single-file-swiftc spirit: no Xcode project, no dependencies.
//
// The menu bar shows a "sethji" wordmark with a live status dot (pulses while
// the crew runs, ✓/✗ when it finishes). The panel shows the crew pipeline as
// role chips that light up as each agent takes its turn, the live output
// stream with the CLI's role colors, a runtime clock, loop-round badge, and a
// verdict banner — plus a notification when the run ends.

// MARK: - Small helpers ------------------------------------------------------

/// Strip ANSI SGR color codes (delegated agents may emit them even with --no-color).
private func stripANSI(_ s: String) -> String {
    guard s.contains("\u{001B}") else { return s }
    var out = ""
    var i = s.startIndex
    while i < s.endIndex {
        let ch = s[i]
        if ch == "\u{001B}", s.index(after: i) < s.endIndex, s[s.index(after: i)] == "[" {
            // skip ESC [ ... final-byte (0x40-0x7E)
            var j = s.index(i, offsetBy: 2)
            while j < s.endIndex, !("\u{40}"..."\u{7E}").contains(s[j]) {
                j = s.index(after: j)
            }
            i = j < s.endIndex ? s.index(after: j) : s.endIndex
        } else {
            out.append(ch)
            i = s.index(after: i)
        }
    }
    return out
}

/// Same stable hash + palette as src/orchestrate.js, so a role keeps the color
/// it has in the terminal.
private let rolePalette: [NSColor] = [
    .systemTeal,    // cyan
    .systemYellow,  // yellow
    .systemPurple,  // magenta
    .systemGreen,   // green
    .systemBlue,    // blue
]

private func roleColor(_ name: String) -> NSColor {
    var h: Int32 = 0
    for u in name.unicodeScalars {
        h = h &* 31 &+ Int32(truncatingIfNeeded: u.value)
    }
    return rolePalette[Int(h.magnitude) % rolePalette.count]
}

private func roundedFont(size: CGFloat, weight: NSFont.Weight) -> NSFont {
    let base = NSFont.systemFont(ofSize: size, weight: weight)
    if let desc = base.fontDescriptor.withDesign(.rounded),
       let font = NSFont(descriptor: desc, size: size) {
        return font
    }
    return base
}

private func mmss(_ seconds: Int) -> String {
    String(format: "%02d:%02d", seconds / 60, seconds % 60)
}

// MARK: - Crew info ----------------------------------------------------------

/// Just enough of crew.json to draw the pipeline: role order, each role's
/// agent · mode, and the loop. Mirrors DEFAULT_CREW in src/config.js.
struct CrewInfo {
    var workflow: [String]
    var detail: [String: String] // role -> "agent · mode"
    var agents: [String: String] // role -> agent name
    var roster: [String]         // built-ins + agents declared in crew.json
    var loopFrom: String?
    var loopTo: String?
    var maxRounds: Int

    static let builtinAgents = ["claude", "codex", "gemini"]

    static let fallback = CrewInfo(
        workflow: ["architect", "coder", "qa"],
        detail: ["architect": "claude · read", "coder": "codex · write", "qa": "gemini · read"],
        agents: ["architect": "claude", "coder": "codex", "qa": "gemini"],
        roster: builtinAgents,
        loopFrom: "qa", loopTo: "coder", maxRounds: 2
    )

    static func load(cwd: String) -> (crew: CrewInfo, fromFile: Bool) {
        let path = (cwd as NSString).appendingPathComponent("crew.json")
        guard let data = FileManager.default.contents(atPath: path),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let workflow = json["workflow"] as? [String], !workflow.isEmpty
        else { return (.fallback, false) }

        var detail: [String: String] = [:]
        var agents: [String: String] = [:]
        if let roles = json["roles"] as? [String: [String: Any]] {
            for (name, def) in roles {
                let agent = def["agent"] as? String ?? "?"
                let mode = def["mode"] as? String ?? "read"
                detail[name] = "\(agent) · \(mode)"
                agents[name] = agent
            }
        }
        var from: String?
        var to: String?
        var max = 0
        if let loop = json["loop"] as? [String: Any] {
            from = loop["from"] as? String
            to = loop["to"] as? String
            max = loop["maxRounds"] as? Int ?? 0
        }
        var roster = builtinAgents
        if let declared = json["agents"] as? [String: Any] {
            for name in declared.keys.sorted() where !roster.contains(name) { roster.append(name) }
        }
        // One chip per unique role, in workflow order.
        var seen = Set<String>()
        let unique = workflow.filter { seen.insert($0).inserted }
        return (CrewInfo(workflow: unique, detail: detail, agents: agents, roster: roster,
                         loopFrom: from, loopTo: to, maxRounds: max), true)
    }
}

// MARK: - Model catalog ------------------------------------------------------

/// Model + effort suggestions per agent, loaded from JSON so the lists are
/// editable without recompiling: ~/.config/sethji/models.json wins, then the
/// models.json bundled with the app, then a built-in fallback.
struct ModelCatalog {
    struct Entry: Codable {
        var models: [String]?
        var efforts: [String]?
    }
    private var entries: [String: Entry]

    func models(for agent: String) -> [String] { entries[agent]?.models ?? [] }
    func efforts(for agent: String) -> [String] { entries[agent]?.efforts ?? [] }

    static func load() -> ModelCatalog {
        let user = ("~/.config/sethji/models.json" as NSString).expandingTildeInPath
        var candidates = [URL(fileURLWithPath: user)]
        if let bundled = Bundle.main.url(forResource: "models", withExtension: "json") {
            candidates.append(bundled)
        }
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let parsed = try? JSONDecoder().decode([String: Entry].self, from: data) {
                return ModelCatalog(entries: parsed)
            }
        }
        return ModelCatalog(entries: [
            "claude": Entry(models: ["opus", "sonnet", "haiku"], efforts: ["low", "medium", "high"]),
            "codex": Entry(models: ["gpt-5-codex", "gpt-5", "o3"], efforts: ["minimal", "low", "medium", "high"]),
            "gemini": Entry(models: ["gemini-2.5-pro", "gemini-2.5-flash"], efforts: []),
        ])
    }
}

// MARK: - Role chip ----------------------------------------------------------

/// One pill per role in the pipeline. Lights up while its agent runs, dims to
/// a check when done, goes red on a FAIL.
final class RoleChip: NSView {
    enum ChipState { case pending, active, done, fail }

    private let label = NSTextField(labelWithString: "")
    private let color: NSColor
    private let baseTitle: String

    var state: ChipState = .pending { didSet { applyState() } }

    init(role: String, detail: String) {
        self.color = roleColor(role)
        self.baseTitle = role.uppercased()
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 11
        layer?.borderWidth = 1
        toolTip = detail
        label.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            heightAnchor.constraint(equalToConstant: 22),
        ])
        applyState()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func applyState() {
        switch state {
        case .pending:
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
            label.textColor = .tertiaryLabelColor
            label.stringValue = baseTitle
            stopPulse()
        case .active:
            layer?.backgroundColor = color.withAlphaComponent(0.16).cgColor
            layer?.borderColor = color.cgColor
            label.textColor = color
            label.stringValue = "▸ \(baseTitle)"
            startPulse()
        case .done:
            layer?.backgroundColor = color.withAlphaComponent(0.10).cgColor
            layer?.borderColor = color.withAlphaComponent(0.35).cgColor
            label.textColor = color.withAlphaComponent(0.9)
            label.stringValue = "\(baseTitle) ✓"
            stopPulse()
        case .fail:
            layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.14).cgColor
            layer?.borderColor = NSColor.systemRed.cgColor
            label.textColor = .systemRed
            label.stringValue = "\(baseTitle) ✗"
            stopPulse()
        }
    }

    private func startPulse() {
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.55
        pulse.duration = 0.7
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        layer?.add(pulse, forKey: "pulse")
    }

    private func stopPulse() {
        layer?.removeAnimation(forKey: "pulse")
    }
}

// MARK: - Runner -------------------------------------------------------------

/// Spawns the sethji CLI and streams its combined stdout+stderr.
/// The task travels in an environment variable and is expanded by zsh as a
/// single quoted word — task text can never inject shell syntax.
final class SethjiRunner {
    private(set) var process: Process?
    var isRunning: Bool { process?.isRunning ?? false }

    func start(task: String, cwd: String,
               agents: String = "", models: String = "", efforts: String = "",
               onChunk: @escaping (String) -> Void,
               onDone: @escaping (Int32) -> Void) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Login shell for PATH; also source ~/.zshrc quietly because nvm-style
        // setups only add node there. Per-role model/effort overrides travel in
        // env vars too, becoming --model/--effort "role=value,…" flags.
        let script = """
        [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" >/dev/null 2>&1
        ARGS=(run "$SETHJI_TASK" --no-color)
        [ -n "${SETHJI_AGENTS:-}" ] && ARGS+=(--agent "$SETHJI_AGENTS")
        [ -n "${SETHJI_MODELS:-}" ] && ARGS+=(--model "$SETHJI_MODELS")
        [ -n "${SETHJI_EFFORTS:-}" ] && ARGS+=(--effort "$SETHJI_EFFORTS")
        if command -v sethji >/dev/null 2>&1; then
          exec sethji "${ARGS[@]}"
        elif [ -n "${SETHJI_CLI:-}" ] && [ -f "$SETHJI_CLI" ] && command -v node >/dev/null 2>&1; then
          exec node "$SETHJI_CLI" "${ARGS[@]}"
        else
          echo "sethji not found. Install it (npm i -g sethji) or re-run app/install_app.sh from the repo."
          exit 127
        fi
        """
        p.arguments = ["-lc", script]
        var env = ProcessInfo.processInfo.environment
        env["SETHJI_TASK"] = task
        if !agents.isEmpty { env["SETHJI_AGENTS"] = agents }
        if !models.isEmpty { env["SETHJI_MODELS"] = models }
        if !efforts.isEmpty { env["SETHJI_EFFORTS"] = efforts }
        if let cli = UserDefaults.standard.string(forKey: "SethjiCLI"), !cli.isEmpty {
            env["SETHJI_CLI"] = cli
        }
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { return } // EOF; terminationHandler unhooks us
            // Lossy decode: a chunk that splits a multibyte char must not be
            // dropped whole (String(data:encoding:) returns nil for it).
            // ponytail: the split char itself renders as U+FFFD; carry the
            // partial bytes over to the next chunk if that ever matters.
            let s = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { onChunk(s) }
        }
        p.terminationHandler = { proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            let status = proc.terminationStatus
            DispatchQueue.main.async { onDone(status) }
        }
        try p.run()
        process = p
    }

    func stop() {
        process?.terminate() // SIGTERM
    }
}

// MARK: - Run panel ----------------------------------------------------------

enum RunState { case idle, running, pass, fail, stopped }

final class RunViewController: NSViewController, NSTextFieldDelegate {
    private let runner = SethjiRunner()

    /// The app delegate mirrors this into the menu-bar wordmark.
    var onStateChange: ((RunState) -> Void)?

    // Header
    private let subtitleLabel = NSTextField(labelWithString: "")
    // Project row
    private let dirLabel = NSTextField(labelWithString: "")
    private let crewLabel = NSTextField(labelWithString: "")
    // Task
    private let taskField = NSTextField()
    // Controls
    private let runButton = NSButton(title: "Run crew", target: nil, action: nil)
    private let stopButton = NSButton(title: "Stop", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "idle")
    // Pipeline
    private let chipsRow = NSStackView()
    private let loopBadge = NSTextField(labelWithString: "")
    private var chips: [String: RoleChip] = [:]
    private var crew: CrewInfo = .fallback
    // Per-role agent/model/effort overrides (collapsible section)
    private let configToggle = NSButton(title: "⚙ Crew setup", target: nil, action: nil)
    private let configStack = NSStackView()
    private var agentPopups: [String: NSPopUpButton] = [:]
    private var modelFields: [String: NSTextField] = [:]
    private var effortPopups: [String: NSPopUpButton] = [:]
    private let catalog = ModelCatalog.load()
    // Output + verdict
    private var outputView: NSTextView!
    private let banner = NSTextField(labelWithString: "")

    // Stream state
    private var lineBuffer = ""
    private var userStopped = false
    private var lastVerdictReason = ""
    private var activeRole: String?
    private var startedAt: Date?
    private var clock: Timer?
    private var currentTurn = "" // "CODER (codex · write)" from the last header

    private var cwd: String {
        get { UserDefaults.standard.string(forKey: "LastDir") ?? NSHomeDirectory() }
        set {
            UserDefaults.standard.set(newValue, forKey: "LastDir")
            refreshProjectUI()
        }
    }

    // MARK: view construction

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 620))

        // Header: wordmark + tagline, Logs on the right
        let wordmark = NSTextField(labelWithString: "sethji")
        wordmark.font = roundedFont(size: 22, weight: .bold)
        subtitleLabel.font = NSFont.systemFont(ofSize: 11)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.stringValue = "your AI crew, in the menu bar"
        let headerText = NSStackView(views: [wordmark, subtitleLabel])
        headerText.orientation = .vertical
        headerText.alignment = .leading
        headerText.spacing = 1

        let logsButton = NSButton(title: "Logs", target: self, action: #selector(openLogs))
        logsButton.bezelStyle = .rounded
        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let headerRow = NSStackView(views: [headerText, headerSpacer, logsButton])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY

        // Project directory row
        let chooseButton = NSButton(title: "Project…", target: self, action: #selector(chooseDir))
        chooseButton.bezelStyle = .rounded
        dirLabel.lineBreakMode = .byTruncatingMiddle
        dirLabel.textColor = .secondaryLabelColor
        dirLabel.font = NSFont.systemFont(ofSize: 12)
        dirLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        crewLabel.font = NSFont.systemFont(ofSize: 11)
        crewLabel.textColor = .tertiaryLabelColor
        let dirRow = NSStackView(views: [chooseButton, dirLabel, crewLabel])
        dirRow.orientation = .horizontal
        dirRow.spacing = 8
        dirRow.alignment = .centerY

        // Task field
        taskField.placeholderString = "task for the crew — e.g. add a /health endpoint and a test  ⏎"
        taskField.font = NSFont.systemFont(ofSize: 13)
        taskField.delegate = self

        // Controls row
        runButton.target = self
        runButton.action = #selector(runTapped)
        runButton.bezelStyle = .rounded
        runButton.keyEquivalent = "\r"
        stopButton.target = self
        stopButton.action = #selector(stopTapped)
        stopButton.bezelStyle = .rounded
        stopButton.isEnabled = false
        statusLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        let controlRow = NSStackView(views: [runButton, stopButton, statusLabel])
        controlRow.orientation = .horizontal
        controlRow.spacing = 8
        controlRow.alignment = .centerY

        // Pipeline chips
        chipsRow.orientation = .horizontal
        chipsRow.spacing = 6
        chipsRow.alignment = .centerY
        loopBadge.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        loopBadge.textColor = .systemOrange

        // Per-role model/effort overrides, tucked behind a disclosure toggle.
        configToggle.target = self
        configToggle.action = #selector(toggleConfig)
        configToggle.bezelStyle = .inline
        configToggle.font = NSFont.systemFont(ofSize: 11)
        configToggle.setButtonType(.toggle)
        configStack.orientation = .vertical
        configStack.alignment = .leading
        configStack.spacing = 6
        configStack.isHidden = true

        // Output view — terminal look
        let scroll = NSTextView.scrollableTextView()
        outputView = (scroll.documentView as! NSTextView)
        outputView.isEditable = false
        outputView.isRichText = true
        outputView.drawsBackground = true
        outputView.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 1)
        outputView.textContainerInset = NSSize(width: 10, height: 10)
        outputView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        scroll.hasVerticalScroller = true
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = NSColor.white.withAlphaComponent(0.08).cgColor

        // Verdict banner (hidden until a run ends)
        banner.isHidden = true
        banner.alignment = .center
        banner.font = roundedFont(size: 13, weight: .bold)
        banner.wantsLayer = true
        banner.layer?.cornerRadius = 6

        // Bottom row
        let clearButton = NSButton(title: "Clear", target: self, action: #selector(clearOutput))
        clearButton.bezelStyle = .rounded
        let bottomSpacer = NSView()
        bottomSpacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let bottomRow = NSStackView(views: [banner, bottomSpacer, clearButton])
        bottomRow.orientation = .horizontal
        bottomRow.spacing = 8
        bottomRow.alignment = .centerY

        let stack = NSStackView(views: [headerRow, dirRow, taskField, controlRow, chipsRow, configToggle, configStack, scroll, bottomRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(14, after: headerRow)
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 14, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)

        let inset: CGFloat = -32
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            headerRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            dirRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            taskField.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            controlRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            bottomRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: inset),
            banner.heightAnchor.constraint(equalToConstant: 24),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 300),
        ])

        self.view = root
        taskField.stringValue = UserDefaults.standard.string(forKey: "LastTask") ?? ""
        refreshProjectUI()
    }

    private func refreshProjectUI() {
        dirLabel.stringValue = (cwd as NSString).abbreviatingWithTildeInPath
        let loaded = CrewInfo.load(cwd: cwd)
        crew = loaded.crew
        crewLabel.stringValue = loaded.fromFile ? "crew: ./crew.json" : "crew: built-in default"
        rebuildChips()
        rebuildConfigRows()
        subtitleLabel.stringValue = crew.workflow.joined(separator: " → ")
            + (crew.maxRounds > 0 ? "  ·  loops ×\(crew.maxRounds)" : "")
    }

    // MARK: per-role model/effort overrides

    @objc private func toggleConfig() {
        configStack.isHidden = configToggle.state != .on
    }

    private var overridesKey: String { "Overrides:" + cwd }

    private func savedOverrides() -> [String: [String: String]] {
        UserDefaults.standard.dictionary(forKey: overridesKey) as? [String: [String: String]] ?? [:]
    }

    /// Read the current UI into UserDefaults (keyed per project folder).
    private func saveOverrides() {
        var all: [String: [String: String]] = [:]
        for role in crew.workflow {
            var entry: [String: String] = [:]
            let chosenAgent = agentPopups[role]?.titleOfSelectedItem ?? crew.agents[role] ?? ""
            if let popup = agentPopups[role], let a = popup.titleOfSelectedItem,
               a != (crew.agents[role] ?? "") {
                entry["agent"] = a
            }
            if let m = modelFields[role]?.stringValue.trimmingCharacters(in: .whitespaces), !m.isEmpty {
                entry["model"] = m
            }
            // Keep the effort only if the chosen agent actually supports it.
            if let popup = effortPopups[role], popup.indexOfSelectedItem > 0,
               let e = popup.titleOfSelectedItem, catalog.efforts(for: chosenAgent).contains(e) {
                entry["effort"] = e
            }
            if !entry.isEmpty { all[role] = entry }
        }
        if all.isEmpty {
            UserDefaults.standard.removeObject(forKey: overridesKey)
        } else {
            UserDefaults.standard.set(all, forKey: overridesKey)
        }
    }

    /// "role=value,…" spec for the CLI's --model / --effort flags.
    private func overrideSpec(_ field: String) -> String {
        let saved = savedOverrides()
        return crew.workflow.compactMap { role -> String? in
            guard let v = saved[role]?[field], !v.isEmpty else { return nil }
            return "\(role)=\(v)"
        }.joined(separator: ",")
    }

    private func rebuildConfigRows() {
        for v in configStack.arrangedSubviews {
            configStack.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        agentPopups.removeAll()
        modelFields.removeAll()
        effortPopups.removeAll()
        let saved = savedOverrides()
        for role in crew.workflow {
            let name = NSTextField(labelWithString: role.uppercased())
            name.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
            name.textColor = roleColor(role)
            name.widthAnchor.constraint(equalToConstant: 90).isActive = true

            // Which AI runs this role: built-ins + agents declared in crew.json.
            let currentAgent = saved[role]?["agent"] ?? crew.agents[role] ?? "claude"
            let agentPopup = NSPopUpButton()
            agentPopup.addItems(withTitles: crew.roster)
            if !crew.roster.contains(currentAgent) { agentPopup.addItem(withTitle: currentAgent) }
            agentPopup.selectItem(withTitle: currentAgent)
            agentPopup.font = NSFont.systemFont(ofSize: 11)
            agentPopup.target = self
            agentPopup.action = #selector(agentChanged)
            agentPopups[role] = agentPopup

            // Dropdown of known models for the chosen agent; free text allowed.
            let model = NSComboBox()
            model.usesDataSource = false
            model.completes = true
            model.addItems(withObjectValues: catalog.models(for: currentAgent))
            model.placeholderString = "model (default)"
            model.font = NSFont.systemFont(ofSize: 11)
            model.stringValue = saved[role]?["model"] ?? ""
            model.widthAnchor.constraint(equalToConstant: 160).isActive = true
            modelFields[role] = model

            let efforts = catalog.efforts(for: currentAgent)
            let effort = NSPopUpButton()
            effort.addItems(withTitles: ["effort: default"] + efforts)
            effort.font = NSFont.systemFont(ofSize: 11)
            if let e = saved[role]?["effort"], let idx = efforts.firstIndex(of: e) {
                effort.selectItem(at: idx + 1)
            }
            effort.isEnabled = !efforts.isEmpty
            effortPopups[role] = effort

            let row = NSStackView(views: [name, agentPopup, model, effort])
            row.orientation = .horizontal
            row.spacing = 8
            row.alignment = .centerY
            configStack.addArrangedSubview(row)
        }
    }

    /// Agent switched: persist, then rebuild so model/effort suggestions match.
    @objc private func agentChanged() {
        saveOverrides()
        rebuildConfigRows()
    }

    private func rebuildChips() {
        for v in chipsRow.arrangedSubviews {
            chipsRow.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        chips.removeAll()
        for (i, role) in crew.workflow.enumerated() {
            if i > 0 {
                let arrow = NSTextField(labelWithString: "→")
                arrow.font = NSFont.systemFont(ofSize: 11)
                arrow.textColor = .tertiaryLabelColor
                chipsRow.addArrangedSubview(arrow)
            }
            let chip = RoleChip(role: role, detail: crew.detail[role] ?? role)
            chips[role] = chip
            chipsRow.addArrangedSubview(chip)
        }
        loopBadge.stringValue = ""
        chipsRow.addArrangedSubview(loopBadge)
    }

    // MARK: actions

    @objc private func chooseDir() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: cwd)
        panel.prompt = "Use as project folder"
        if panel.runModal() == .OK, let url = panel.url {
            cwd = url.path
        }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) {
            runTapped()
            return true
        }
        return false
    }

    @objc private func runTapped() {
        guard !runner.isRunning else { return }
        let task = taskField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { NSSound.beep(); return }
        UserDefaults.standard.set(task, forKey: "LastTask")

        clearOutput()
        saveOverrides()    // capture model/effort edits before the rows rebuild
        refreshProjectUI() // re-read crew.json in case it changed
        userStopped = false
        lastVerdictReason = ""
        activeRole = nil
        currentTurn = ""
        setRunning(true)
        onStateChange?(.running)
        statusLabel.stringValue = "00:00  starting crew…"
        append("$ sethji run \"\(task)\"\n", color: .secondaryLabelColor)

        startedAt = Date()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.tickClock()
        }

        do {
            try runner.start(
                task: task, cwd: cwd,
                agents: overrideSpec("agent"),
                models: overrideSpec("model"), efforts: overrideSpec("effort"),
                onChunk: { [weak self] chunk in self?.feed(chunk) },
                onDone: { [weak self] status in self?.finished(status: status) }
            )
        } catch {
            append("failed to launch: \(error.localizedDescription)\n", color: .systemRed)
            setRunning(false)
            onStateChange?(.fail)
        }
    }

    private func tickClock() {
        guard let start = startedAt else { return }
        let elapsed = Int(Date().timeIntervalSince(start))
        let turn = currentTurn.isEmpty ? "warming up…" : currentTurn
        statusLabel.stringValue = "\(mmss(elapsed))  \(turn)"
    }

    @objc private func stopTapped() {
        userStopped = true
        runner.stop()
    }

    @objc private func clearOutput() {
        outputView.textStorage?.setAttributedString(NSAttributedString(string: ""))
        banner.isHidden = true
        lineBuffer = ""
        loopBadge.stringValue = ""
        for chip in chips.values { chip.state = .pending }
    }

    @objc func openLogs() {
        let runs = (cwd as NSString).appendingPathComponent(".sethji/runs")
        if FileManager.default.fileExists(atPath: runs) {
            NSWorkspace.shared.open(URL(fileURLWithPath: runs))
        } else {
            NSSound.beep()
        }
    }

    // MARK: streaming + rendering

    private func setRunning(_ running: Bool) {
        runButton.isEnabled = !running
        taskField.isEnabled = !running
        stopButton.isEnabled = running
        if !running {
            clock?.invalidate()
            clock = nil
        }
    }

    private func feed(_ chunk: String) {
        lineBuffer += stripANSI(chunk)
        var lines = lineBuffer.components(separatedBy: "\n")
        lineBuffer = lines.removeLast()
        for line in lines { render(line: line) }
    }

    private func render(line: String) {
        // Role header, exactly as the CLI prints it: ▌ CODER (codex · write)
        if line.hasPrefix("▌ ") {
            let rest = String(line.dropFirst(2))
            let roleName = (rest.components(separatedBy: " (").first ?? rest)
                .trimmingCharacters(in: .whitespaces).lowercased()
            markRoleActive(roleName)
            currentTurn = rest
            tickClock()
            append(line + "\n", color: roleColor(roleName), bold: true)
            return
        }
        // QA verdict line inside the stream
        if line.range(of: #"^\s*VERDICT:\s*(PASS|FAIL)"#, options: .regularExpression) != nil {
            let fail = line.uppercased().contains("FAIL")
            if fail, let colon = line.range(of: "FAIL:") {
                lastVerdictReason = String(line[colon.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            append(line + "\n", color: fail ? .systemRed : .systemGreen, bold: true)
            return
        }
        // Loop-back note: ↻ QA failed (round 1/2): … — looping back to coder.
        if line.hasPrefix("↻") {
            if let m = line.range(of: #"round \d+/\d+"#, options: .regularExpression) {
                loopBadge.stringValue = "↻ \(line[m])"
            }
            append(line + "\n", color: .systemOrange)
            return
        }
        // Final CLI summary
        if line.hasPrefix("✓ PASS") || line.hasPrefix("✗ FAIL") {
            append(line + "\n", color: line.hasPrefix("✓") ? .systemGreen : .systemRed, bold: true)
            return
        }
        append(line + "\n", color: NSColor(calibratedWhite: 0.86, alpha: 1))
    }

    private func markRoleActive(_ role: String) {
        if let prev = activeRole, let prevChip = chips[prev] {
            prevChip.state = .done
        }
        activeRole = role
        chips[role]?.state = .active
    }

    private func finished(status: Int32) {
        if !lineBuffer.isEmpty {
            render(line: lineBuffer)
            lineBuffer = ""
        }
        let elapsed = startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0
        setRunning(false)

        if userStopped {
            for chip in chips.values where chip.state == .active { chip.state = .pending }
            showBanner("■ stopped after \(mmss(elapsed))", color: .secondaryLabelColor)
            statusLabel.stringValue = "stopped"
            onStateChange?(.stopped)
            return
        }

        let pass = status == 0
        if let last = activeRole {
            chips[last]?.state = pass ? .done : .fail
        }
        if pass {
            for chip in chips.values where chip.state == .active { chip.state = .done }
        }

        showBanner(
            pass ? "✓ PASS · \(mmss(elapsed))"
                 : "✗ FAIL · \(mmss(elapsed))" + (lastVerdictReason.isEmpty ? "" : " · \(lastVerdictReason)"),
            color: pass ? .systemGreen : .systemRed
        )
        statusLabel.stringValue = pass ? "done in \(mmss(elapsed))" : "failed after \(mmss(elapsed))"
        onStateChange?(pass ? .pass : .fail)

        let body = pass
            ? "Crew finished in \(mmss(elapsed)) — VERDICT PASS"
            : "Crew finished in \(mmss(elapsed)) — VERDICT FAIL"
              + (lastVerdictReason.isEmpty ? "" : ": \(lastVerdictReason)")
        notify(title: "sethji", body: body)
    }

    private func showBanner(_ text: String, color: NSColor) {
        banner.stringValue = "  \(text)  "
        banner.textColor = color
        banner.layer?.backgroundColor = color.withAlphaComponent(0.13).cgColor
        banner.isHidden = false
    }

    private func append(_ text: String, color: NSColor, bold: Bool = false) {
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: bold ? .bold : .regular)
        let attr = NSAttributedString(string: text, attributes: [.foregroundColor: color, .font: font])
        outputView.textStorage?.append(attr)
        outputView.scrollToEndOfDocument(nil)
    }

    private func notify(title: String, body: String) {
        // UNUserNotificationCenter needs a real bundle; outside one, just beep.
        guard Bundle.main.bundleIdentifier != nil else { NSSound.beep(); return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        )
    }
}

// MARK: - App delegate -------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let runVC = RunViewController()
    private var pulseTimer: Timer?
    private var pulseOn = false
    private var runState: RunState = .idle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.toolTip = "sethji — run your AI crew"
            button.target = self
            button.action = #selector(statusClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            // The boss himself, from the same drawing as the app icon.
            let icon = sethjiIconImage(card: false)
            icon.size = NSSize(width: 20, height: 20)
            button.image = icon
            button.imagePosition = .imageLeft
        }
        setWordmark(suffix: nil, color: nil)

        popover.contentViewController = runVC
        popover.contentSize = NSSize(width: 600, height: 620)
        popover.behavior = .transient

        runVC.onStateChange = { [weak self] state in self?.stateChanged(state) }

        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    // MARK: menu-bar status

    /// Icon-only button; an optional colored status glyph sits beside the boss.
    private func setWordmark(suffix: String?, color: NSColor?) {
        guard let button = statusItem.button else { return }
        guard let suffix = suffix, let color = color else {
            button.attributedTitle = NSAttributedString(string: "")
            return
        }
        button.attributedTitle = NSAttributedString(
            string: " \(suffix)",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .foregroundColor: color,
                .baselineOffset: -1,
            ]
        )
    }

    private func stateChanged(_ state: RunState) {
        runState = state
        pulseTimer?.invalidate()
        pulseTimer = nil
        switch state {
        case .idle:
            setWordmark(suffix: nil, color: nil)
        case .running:
            pulseOn = true
            setWordmark(suffix: "●", color: .systemOrange)
            pulseTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                self.pulseOn.toggle()
                self.setWordmark(suffix: self.pulseOn ? "●" : "○", color: .systemOrange)
            }
        case .pass:
            setWordmark(suffix: "✓", color: .systemGreen)
        case .fail:
            setWordmark(suffix: "✗", color: .systemRed)
        case .stopped:
            setWordmark(suffix: "■", color: .secondaryLabelColor)
        }
    }

    // MARK: clicks

    @objc private func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
            return
        }
        togglePopover()
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            // Seeing the panel clears a lingering ✓/✗ back to the plain wordmark.
            if runState == .pass || runState == .fail || runState == .stopped {
                stateChanged(.idle)
            }
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Logs Folder", action: #selector(openLogsFromMenu), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit sethji", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil // so left-click goes back to the popover
    }

    @objc private func openLogsFromMenu() {
        runVC.openLogs()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // Show notifications even while the app is frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

// MARK: - main ---------------------------------------------------------------

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
