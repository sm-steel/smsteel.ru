import { SceneBackground } from "@/components/scene-background"
// import { ThemeToggle } from "@/components/theme-toggle"
// import { Button } from "@/components/ui/button"
// import {
//   Card,
//   CardContent,
//   CardDescription,
//   CardHeader,
//   CardTitle,
// } from "@/components/ui/card"
// import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
// import { Input } from "@/components/ui/input"
// import { Spinner } from "@/components/ui/spinner"

function App() {
  return (
    <div className="relative z-10 flex min-h-svh items-center justify-center p-6">
      <SceneBackground />
      {/*<ThemeToggle />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Login to your account</CardTitle>
          <CardDescription>
            Enter your email below to login to your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="m@example.com"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input id="password" name="password" type="password" required />
              </Field>
              <Field>
                <Button type="submit" disabled={loading}>
                  {loading && <Spinner data-icon="inline-start" />}
                  {loading ? "Signing in…" : "Login"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>*/}
    </div>
  )
}

export default App
