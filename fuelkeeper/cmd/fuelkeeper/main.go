package main

import (
	"fmt"
	"os"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
)

func main() {
	if _, err := config.Load(os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println("fuelkeeper: wiring lands in Task 10")
}
