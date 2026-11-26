@auth
Feature: Login

  Rule: Valid credentials
    Scenario: Successful login
      Given a registered user
      When they enter the right password
      Then they see the dashboard

  Rule: Invalid credentials
    Scenario: Wrong password
      Given a registered user
      When they enter a wrong password
      Then they see an error
