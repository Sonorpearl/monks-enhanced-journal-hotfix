const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "monks-enhanced-journal.js"), "utf8");
const classSource = source.slice(source.indexOf("export class MonksEnhancedJournal"),
    source.indexOf('\nHooks.on("renderJournalDirectory"')).replace("export class", "class");
const sheetNames = [
    "ListSheet", "EncounterSheet", "EventSheet", "OrganizationSheet", "PersonSheet",
    "PictureSheet", "PlaceSheet", "PointOfInterestSheet", "QuestSheet", "ShopSheet",
    "LootSheet", "SlideshowSheet", "TextImageEntrySheet"
];

test("manifest pins both public release assets without changing the module ID", () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "module.json"), "utf8"));
    const base = `https://github.com/Sonorpearl/monks-enhanced-journal-hotfix/releases/download/${manifest.version}`;
    assert.equal(manifest.id, "monks-enhanced-journal");
    assert.equal(manifest.manifest, `${base}/module.json`);
    assert.equal(manifest.download, `${base}/monks-enhanced-journal-${manifest.version}.zip`);
});

// Model the reported core lifecycle, not a substitute for running Foundry itself.
function setup({ strict = true } = {}) {
    const pending = [];
    const registrations = [];
    const warnings = [];
    const CONFIG = { JournalEntryPage: { sheetClasses: {} } };
    const game = { ready: false, documentTypes: { JournalEntryPage: [] }, user: { isGM: true } };
    const sheets = Object.fromEntries(sheetNames.map(name => [name, { [name]: class {} }[name]]));
    const DocumentSheetConfig = {
        registerSheet(documentClass, scope, cls, options) {
            if (!game.ready) {
                pending.push([documentClass, scope, cls, options]);
                return;
            }
            registrations.push({ cls, options });
            const id = `${scope}.${cls.name}`;
            for (const type of options.types) {
                const classes = CONFIG.JournalEntryPage.sheetClasses;
                if (!classes[type]) {
                    if (strict) {
                        warnings.push(type);
                        continue;
                    }
                    classes[type] = {};
                }
                classes[type][id] = { id, cls, default: options.makeDefault, label: options.label };
            }
        },
        getSheetClassesForSubType(type) {
            return Object.values(CONFIG.JournalEntryPage.sheetClasses[type]);
        }
    };
    const context = vm.createContext({
        CONFIG, game, ...sheets, JournalEntryPage: class JournalEntryPage {},
        foundry: {
            applications: { apps: { DocumentSheetConfig } },
            utils: { mergeObject: (target, values) => Object.assign(target, values) }
        },
        i18n: key => key
    });
    vm.runInContext(`${classSource}\nglobalThis.MEJ = MonksEnhancedJournal;`, context);
    const MEJ = context.MEJ;
    game.documentTypes.JournalEntryPage = ["text", "image", "video", "pdf",
        ...Object.keys(MEJ.getDocumentTypes()).map(type => `monks-enhanced-journal.${type}`)];
    MEJ.registerSheetClasses();

    // Core discards init-time placeholders before replaying queued registrations.
    CONFIG.JournalEntryPage.sheetClasses = Object.fromEntries(
        game.documentTypes.JournalEntryPage.map(type => [type, {}]));
    game.ready = true;
    for (const args of pending) DocumentSheetConfig.registerSheet(...args);
    registrations.length = 0;
    return { MEJ, CONFIG, DocumentSheetConfig, registrations, warnings };
}

test("14.369 reproduces the reported exception before repair for all 13 types", () => {
    const { MEJ, DocumentSheetConfig, warnings } = setup();
    assert.equal(Object.keys(MEJ.getDocumentTypes()).length, 13);
    for (const type of Object.keys(MEJ.getDocumentTypes())) {
        assert.throws(() => DocumentSheetConfig.getSheetClassesForSubType(type), TypeError);
    }
    assert.equal(warnings.length, 14); // 13 primary registrations plus Text/Image.
});

test("repair restores all 13 correct sheet classes and theme lookups", () => {
    const { MEJ, CONFIG, DocumentSheetConfig, warnings } = setup();
    const namespacedBefore = Object.fromEntries(Object.entries(CONFIG.JournalEntryPage.sheetClasses));
    MEJ.repairSheetClasses();
    for (const [type, cls] of Object.entries(MEJ.getDocumentTypes())) {
        const choices = DocumentSheetConfig.getSheetClassesForSubType(type);
        assert.equal(choices.length, 1);
        assert.equal(choices[0].cls, cls);
        assert.equal(choices[0].label, type === "journalentry" ? "Text and Image" : MEJ.getTypeLabels()[type]);
        const namespaced = `monks-enhanced-journal.${type}`;
        assert.equal(CONFIG.JournalEntryPage.sheetClasses[namespaced], namespacedBefore[namespaced]);
        assert.notEqual(CONFIG.JournalEntryPage.sheetClasses[type], namespacedBefore[namespaced]);
    }
    assert.equal(warnings.length, 14, "repair must not produce more unknown-type warnings");
});

test("repair covers exactly the module's declared page types", () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "module.json"), "utf8"));
    const { MEJ, CONFIG } = setup();
    const before = new Set(Object.keys(CONFIG.JournalEntryPage.sheetClasses));
    MEJ.repairSheetClasses();
    const added = Object.keys(CONFIG.JournalEntryPage.sheetClasses).filter(type => !before.has(type));
    assert.deepEqual(added.sort(), Object.keys(manifest.documentTypes.JournalEntryPage).sort());
});

test("14.368 keeps its existing registrations and defaults unchanged", () => {
    const { MEJ, CONFIG, registrations } = setup({ strict: false });
    const before = JSON.stringify(CONFIG.JournalEntryPage.sheetClasses);
    MEJ.repairSheetClasses();
    assert.equal(registrations.length, 0);
    assert.equal(JSON.stringify(CONFIG.JournalEntryPage.sheetClasses), before);
});

test("repair is idempotent and preserves existing third-party/core registrations", () => {
    const { MEJ, CONFIG, registrations } = setup();
    const existing = { "custom.PersonSheet": { cls: class CustomPersonSheet {}, default: true } };
    CONFIG.JournalEntryPage.sheetClasses.person = existing;
    const core = CONFIG.JournalEntryPage.sheetClasses.text;
    core["core.TextSheet"] = { cls: class TextSheet {}, default: true };
    MEJ.repairSheetClasses();
    assert.equal(CONFIG.JournalEntryPage.sheetClasses.person, existing);
    assert.equal(CONFIG.JournalEntryPage.sheetClasses.text, core);
    assert.equal(core["core.TextSheet"].default, true);
    assert.equal(registrations.some(({ options }) => options.types.includes("person")), false);
    const count = registrations.length;
    MEJ.repairSheetClasses();
    assert.equal(registrations.length, count);
});

test("type selection for legacy and namespaced pages resolves without persisted writes", () => {
    const { MEJ, DocumentSheetConfig } = setup();
    MEJ.repairSheetClasses();
    for (const [type, cls] of Object.entries(MEJ.getDocumentTypes())) {
        for (const storedType of [type, `monks-enhanced-journal.${type}`]) {
            const page = {
                documentName: "JournalEntryPage", type: storedType,
                flags: { "monks-enhanced-journal": { type } },
                parent: { documentName: "JournalEntry", flags: {} },
                _source: { type: storedType, text: { content: "<p>Keep this text</p>" } },
                update() { assert.fail("repair must not persist document changes"); },
                unsetFlag() { assert.fail("known MEJ types must retain their flags"); }
            };
            const before = JSON.stringify({ source: page._source, flags: page.flags });
            MEJ.fixType(page);
            assert.equal(page.type, type);
            assert.equal(DocumentSheetConfig.getSheetClassesForSubType(page.type)[0].cls, cls);
            assert.equal(JSON.stringify({ source: page._source, flags: page.flags }), before);
        }
    }
});

test("ready repairs registrations before initializing integrations", async () => {
    const { MEJ, DocumentSheetConfig } = setup();
    const stop = new Error("stop before unrelated ready work");
    let repaired = false;
    const repair = MEJ.repairSheetClasses;
    MEJ.repairSheetClasses = () => {
        repair.call(MEJ);
        repaired = true;
        assert.equal(DocumentSheetConfig.getSheetClassesForSubType("person")[0].cls.name, "PersonSheet");
        throw stop;
    };
    await assert.rejects(MEJ.ready(), error => error === stop);
    assert.equal(repaired, true);
});
