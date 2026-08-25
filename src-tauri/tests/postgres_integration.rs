//! Opt-in integration coverage for a real PostgreSQL instance.
//!
//! Run with `NEXTERM_TEST_POSTGRES_HOST`, `NEXTERM_TEST_POSTGRES_PORT`,
//! `NEXTERM_TEST_POSTGRES_USER`, `NEXTERM_TEST_POSTGRES_PASSWORD`, and
//! `NEXTERM_TEST_POSTGRES_DATABASE` set in the environment.

#[tokio::test]
#[ignore = "requires an explicitly configured local PostgreSQL instance"]
async fn connects_queries_and_reads_catalog() {
    let host = std::env::var("NEXTERM_TEST_POSTGRES_HOST").expect("test host is required");
    let port = std::env::var("NEXTERM_TEST_POSTGRES_PORT")
        .expect("test port is required")
        .parse::<u16>()
        .expect("test port must be a valid u16");
    let user = std::env::var("NEXTERM_TEST_POSTGRES_USER").expect("test user is required");
    let password = std::env::var("NEXTERM_TEST_POSTGRES_PASSWORD").expect("test password is required");
    let database = std::env::var("NEXTERM_TEST_POSTGRES_DATABASE").expect("test database is required");

    let mut config = tokio_postgres::Config::new();
    config.host(host).port(port).user(user).password(password).dbname(database.clone());
    let (client, connection) = config.connect(tokio_postgres::NoTls).await.expect("PostgreSQL connection should succeed");
    tokio::spawn(async move { connection.await.expect("PostgreSQL driver should stay healthy"); });

    let row = client.query_one("SELECT current_database(), current_user", &[]).await.expect("basic query should succeed");
    assert_eq!(row.try_get::<_, String>(0).expect("database value"), database);
    assert!(!row.try_get::<_, String>(1).expect("user value").is_empty());

    let schemas = client.query("SELECT nspname FROM pg_namespace WHERE nspname = 'public'", &[]).await.expect("catalog query should succeed");
    assert!(!schemas.is_empty(), "public schema should be available");
}
