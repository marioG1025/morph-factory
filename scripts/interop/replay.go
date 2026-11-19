// Replay signed releases using the upstream client Host and its wazero engine.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	"github.com/nik190799/live-layer-protocol/impl/go/llp"
)

type fixture struct {
	App       string
	PublicKey map[string]any
	Seed      map[string]any
	Blobs     map[string][]byte
	Releases  []struct {
		Manifest map[string]any
		Sig      string
	}
	Steps []struct {
		Label, Action, Event, Key string
		Release                   int
		Value, Tree               any
		Store                     map[string]any
	}
}

func run(filename string) error {
	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	key, err := llp.ParseJWK(f.PublicKey)
	if err != nil {
		return err
	}
	host, err := llp.NewHost(llp.Options{App: f.App, TrustedKeys: []*llp.PublicKey{key}})
	if err != nil {
		return err
	}
	defer host.Close()
	for k, v := range f.Seed {
		host.KV.Set(k, v)
	}
	fetched := 0
	for _, step := range f.Steps {
		switch step.Action {
		case "apply":
			release := f.Releases[step.Release]
			result := host.Apply(release.Manifest, release.Sig, func(hash string) ([]byte, error) {
				data, found := f.Blobs[hash]
				if !found {
					return nil, fmt.Errorf("unexpected blob request %s", hash)
				}
				fetched++
				return data, nil
			})
			if !result.OK {
				return fmt.Errorf("%s rejected: %s (%s)", step.Label, result.Reason, result.Code)
			}
		case "dispatch":
			host.Dispatch("review", step.Event, "")
		case "set":
			host.KV.Set(step.Key, step.Value)
		default:
			return fmt.Errorf("unknown replay action %q", step.Action)
		}
		views := host.Render()
		if len(views) != 1 || views[0].Slot != "review" || views[0].Error != "" {
			return fmt.Errorf("%s: unexpected client slot or render error", step.Label)
		}
		if !reflect.DeepEqual(views[0].Tree.JSON(), step.Tree) {
			return fmt.Errorf("%s: Go's rendered tree differs from JavaScript's", step.Label)
		}
		if !reflect.DeepEqual(host.KV.Snapshot(), step.Store) {
			return fmt.Errorf("%s: Go's review store differs from JavaScript's", step.Label)
		}
		fmt.Printf("PASS  v%.0f  %s (full tree + state)\n", host.Version, step.Label)
	}
	if len(f.Steps) != 6 || len(f.Releases) != 3 || fetched != 2 {
		return fmt.Errorf("expected 6 renders, 3 signed releases and 2 blob fetches; observed %d, %d and %d",
			len(f.Steps), len(f.Releases), fetched)
	}
	fmt.Println("PASS  Restoring the previous layer reused the cached blob.")
	return nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: replay <fixture.json>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
