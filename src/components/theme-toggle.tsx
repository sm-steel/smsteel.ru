import { Moon, Sun } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"

function getInitialIsDark() {
  return document.documentElement.classList.contains("dark")
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(getInitialIsDark)

  function toggleTheme() {
    const next = !isDark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("theme", next ? "dark" : "light")
    setIsDark(next)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="absolute top-4 right-4"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  )
}
