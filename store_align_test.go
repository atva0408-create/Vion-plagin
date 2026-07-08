package sdk

import (
	"testing"
)

func TestDefineSchemasSeedsTypedDefaults(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeString, Key: "s"},
		{Type: JsonSchemaTypeNumber, Key: "n"},
		{Type: JsonSchemaTypeBoolean, Key: "b"},
		{Type: JsonSchemaTypeArray, Key: "a"},
		{Type: JsonSchemaTypeButton, Key: "btn"},
	})

	if got := ds.GetValue("s"); got != "" {
		t.Errorf("string default = %v, want \"\"", got)
	}
	if got := ds.GetValue("n"); !deepEqualLoose(got, 0) {
		t.Errorf("number default = %v, want 0", got)
	}
	if got := ds.GetValue("b"); got != false {
		t.Errorf("boolean default = %v, want false", got)
	}
	if !ds.HasValue("a") {
		t.Error("array key not seeded with a default")
	}
	if ds.HasValue("btn") {
		t.Error("button type must not seed a value")
	}
}

func TestDefineSchemasKeepsStoredObjectValues(t *testing.T) {
	mp := newMemPersistence()
	loc := storeLocation{kind: storeLocationPlugin}
	writeLocation(mp.doc, loc, map[string]any{"obj": map[string]any{"nested": "kept"}})

	ds := newDeviceStorage(mp, loc, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeArray, Key: "obj", Store: Bool(true)}})

	got := ds.GetValue("obj")
	if !deepEqualLoose(got, map[string]any{"nested": "kept"}) {
		t.Errorf("stored object value dropped by DefineSchemas: %v", got)
	}
}

func TestGetConfigResolvesOnGet(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeString, Key: "computed", Store: Bool(true), OnGet: func() any { return "live" }},
	})

	config, _ := ds.GetConfig()["config"].(map[string]any)
	if config["computed"] != "live" {
		t.Errorf("onGet not baked into config snapshot: %v", config["computed"])
	}
}

func TestSetConfigDeepMergesNestedKeys(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeArray, Key: "obj", Store: Bool(true)}})

	if err := ds.SetConfig(map[string]any{"obj": map[string]any{"a": 1, "b": 2}}); err != nil {
		t.Fatal(err)
	}
	if err := ds.SetConfig(map[string]any{"obj": map[string]any{"b": 3}}); err != nil {
		t.Fatal(err)
	}

	// The sibling key "a" must survive a partial update of "b".
	if got := ds.GetValue("obj"); !deepEqualLoose(got, map[string]any{"a": 1, "b": 3}) {
		t.Errorf("deep merge dropped sibling keys: %v", got)
	}
}

func TestOnSetReceivesNewThenOld(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())

	got := make(chan [2]any, 1)
	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeString, Key: "k", Store: Bool(true), OnSet: func(newValue, oldValue any) any {
			got <- [2]any{newValue, oldValue}
			return nil
		}},
	})

	if err := ds.SetValue("k", "first"); err != nil {
		t.Fatal(err)
	}
	<-got
	if err := ds.SetValue("k", "second"); err != nil {
		t.Fatal(err)
	}
	pair := <-got
	if pair[0] != "second" || pair[1] != "first" {
		t.Errorf("onSet got (new=%v, old=%v), want (second, first)", pair[0], pair[1])
	}
}

func TestDeviceStorageDestroyDeletesLocation(t *testing.T) {
	mp := newMemPersistence()
	loc := storeLocation{kind: storeLocationCamera, cameraID: "cam-1"}
	ds := newDeviceStorage(mp, loc, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeString, Key: "host", Store: Bool(true)}})

	if err := ds.SetValue("host", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}
	if mp.persisted(loc) == nil {
		t.Fatal("camera location was not persisted")
	}

	if err := ds.Destroy(); err != nil {
		t.Fatal(err)
	}
	if mp.persisted(loc) != nil {
		t.Errorf("destroy left the location behind: %v", mp.persisted(loc))
	}
	if ds.HasValue("host") {
		t.Error("destroy did not clear the in-memory values")
	}
}
