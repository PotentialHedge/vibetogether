use vibetogether_protocol::{is_message, message_type, names_of, parameter_of};

#[test]
fn a_quoted_parameter_hides_no_other() {
  assert_eq!(
    names_of(r#"text/plain; fyi="x ;ping=bob "; ping="""#, "ping"),
    Vec::<String>::new()
  );
  assert_eq!(names_of(r#"text/plain; ping="bob""#, "ping"), ["bob"]);
  assert_eq!(names_of("text/plain; ping=bob", "ping"), ["bob"]);
  assert_eq!(names_of("text/plain;ping=\"a  b\"", "PING"), ["a", "b"]);
  assert_eq!(parameter_of("text/plain", "ping"), None);
  assert_eq!(
    parameter_of(r#"text/plain; ping="a\"b""#, "ping").as_deref(),
    Some("a\"b")
  );
  // The first of a name counts, and reading stops at the first malformed parameter.
  assert_eq!(names_of("text/plain; ping=a; ping=b", "ping"), ["a"]);
  assert_eq!(parameter_of("text/plain; broken; ping=a", "ping"), None);
  assert_eq!(parameter_of(r#"text/plain; ping="open"#, "ping"), None);
}

#[test]
fn a_message_type_round_trips() {
  let names = ["ben".to_string(), "ben/claude".to_string()];
  let ty = message_type("text/markdown", Some(&names), &["luis".to_string()]);
  assert_eq!(ty, r#"text/markdown; ping="ben ben/claude"; fyi="luis""#);
  assert_eq!(names_of(&ty, "ping"), names);
  assert_eq!(names_of(&ty, "fyi"), ["luis"]);
  assert_eq!(
    message_type("text/plain", Some(&[]), &[]),
    r#"text/plain; ping="""#
  );
  assert_eq!(message_type("text/plain", None, &[]), "text/plain");
}

#[test]
fn an_extensions_entry_is_no_message() {
  assert!(is_message("text/markdown; ping=\"\""));
  assert!(is_message("image/png"));
  assert!(!is_message("application/vnd.vibetogether.join"));
  assert!(!is_message("application/VND.example.cursor+json"));
}
