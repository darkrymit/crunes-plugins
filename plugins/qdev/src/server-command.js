export function buildMvnwCommand(profile) {
  return `./mvnw quarkus:dev -Dquarkus.console.basic=true -Dquarkus.profile=${profile}`
}
